#include "native_cli_platform_stage.hpp"
#include "native_cli_paths.hpp"

#include "native_cli_macho.hpp"
#include "native_cli_web_shell.hpp"
#include "native_cli_windows_pe.hpp"

#include <noveltea/core/player_bootstrap.hpp>
#include <miniz/miniz.h>

#include <algorithm>
#include <array>
#include <chrono>
#include <cctype>
#include <cstdlib>
#include <cstdint>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <iterator>
#include <limits>
#include <map>
#include <numeric>
#include <optional>
#include <random>
#include <set>
#include <span>
#include <stdexcept>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#if defined(_WIN32)
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <Windows.h>
#else
#include <fcntl.h>
#include <sys/file.h>
#include <unistd.h>
#endif

namespace noveltea::cli {
namespace {
namespace fs = std::filesystem;
using Json = PlatformJson;

struct SourceChanged : std::runtime_error {
    using std::runtime_error::runtime_error;
};

struct ExportCancelled : std::runtime_error {
    using std::runtime_error::runtime_error;
};

void check_cancellation(const PlatformExportTools& tools)
{
    if (tools.cancelled && tools.cancelled())
        throw ExportCancelled("Platform export was cancelled.");
}

std::string path_text(const fs::path& path)
{
    const auto encoded = path.u8string();
    return {encoded.begin(), encoded.end()};
}

std::string read_file(const fs::path& source)
{
    std::ifstream stream(source, std::ios::binary);
    if (!stream)
        throw std::runtime_error("Cannot read staged platform input: " + path_text(source));
    return {std::istreambuf_iterator<char>(stream), std::istreambuf_iterator<char>()};
}

std::string digest(std::string_view source)
{
    return core::sha256_hex(std::as_bytes(std::span(source.data(), source.size())));
}

void write_file(const fs::path& target, std::string_view bytes)
{
    fs::create_directories(target.parent_path());
    std::ofstream stream(target, std::ios::binary | std::ios::trunc);
    if (!stream || !stream.write(bytes.data(), static_cast<std::streamsize>(bytes.size())) ||
        !stream.flush())
        throw std::runtime_error("Cannot write staged platform file: " + path_text(target));
}

void sync_directory(const fs::path& directory)
{
#if !defined(_WIN32)
    const int handle = open(directory.c_str(), O_RDONLY | O_DIRECTORY | O_CLOEXEC);
    if (handle < 0)
        throw std::runtime_error("Cannot sync platform publication directory.");
    const int result = fsync(handle);
    const int closed = close(handle);
    if (result != 0 || closed != 0)
        throw std::runtime_error("Failed to sync platform publication directory.");
#else
    (void)directory; // Windows rename uses MOVEFILE_WRITE_THROUGH.
#endif
}

void publish_atomic_file(const fs::path& destination, const std::string& data,
                         std::string_view nonce)
{
    const auto temporary =
        native_path_from_utf8(path_text(destination) + ".new-" + std::string(nonce));
    // With the destination lock held, an ordinary same-nonce temporary file
    // is debris left by a previous interrupted journal update. Discard it
    // before retrying, but reject unsafe filesystem types.
    const auto temporary_status = fs::symlink_status(temporary);
    if (fs::exists(temporary_status)) {
        if (!fs::is_regular_file(temporary_status) || fs::is_symlink(temporary_status))
            throw std::runtime_error("Unsafe publication journal temporary path.");
        fs::remove(temporary);
    }
#if defined(_WIN32)
    const HANDLE handle = CreateFileW(temporary.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_NEW,
                                      FILE_ATTRIBUTE_NORMAL, nullptr);
    if (handle == INVALID_HANDLE_VALUE)
        throw std::runtime_error("Cannot reserve publication journal file.");
    bool written = true;
    std::size_t offset = 0;
    while (written && offset < data.size()) {
        DWORD count = 0;
        const auto chunk =
            static_cast<DWORD>(std::min<std::size_t>(data.size() - offset, 0xffffffffu));
        written = WriteFile(handle, data.data() + offset, chunk, &count, nullptr) != 0 && count > 0;
        offset += count;
    }
    if (written)
        written = FlushFileBuffers(handle) != 0;
    if (!CloseHandle(handle) || !written)
        throw std::runtime_error("Cannot flush platform publication journal.");
    if (!MoveFileExW(temporary.c_str(), destination.c_str(),
                     MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH))
        throw std::runtime_error("Cannot atomically publish platform journal.");
#else
    const int handle = open(temporary.c_str(), O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0600);
    if (handle < 0)
        throw std::runtime_error("Cannot reserve platform publication journal.");
    bool written = true;
    std::size_t offset = 0;
    while (written && offset < data.size()) {
        const auto count = write(handle, data.data() + offset, data.size() - offset);
        if (count < 0 && errno == EINTR)
            continue;
        written = count > 0;
        if (written)
            offset += static_cast<std::size_t>(count);
    }
    if (written)
        written = fsync(handle) == 0;
    if (close(handle) != 0 || !written)
        throw std::runtime_error("Cannot flush platform publication journal.");
    fs::rename(temporary, destination);
    sync_directory(destination.parent_path());
#endif
}

void refuse_unsafe_entry(const fs::path& path)
{
    const auto status = fs::symlink_status(path);
    if (fs::is_symlink(status) || (fs::exists(status) && !fs::is_regular_file(status)))
        throw std::runtime_error("Platform input is not an ordinary file: " + path_text(path));
}

fs::path safe_child(const fs::path& root, const std::string& relative)
{
    if (relative.empty() || relative.front() == '/' || relative.find('\\') != std::string::npos ||
        relative.find(':') != std::string::npos)
        throw std::runtime_error("Invalid platform relative path: " + relative);
    fs::path result = root;
    std::size_t offset = 0;
    do {
        const auto end = relative.find('/', offset);
        const auto part = relative.substr(offset, end == std::string::npos ? end : end - offset);
        if (part.empty() || part == "." || part == "..")
            throw std::runtime_error("Invalid platform relative path: " + relative);
        result /= native_path_from_utf8(part);
        if (fs::is_symlink(fs::symlink_status(result)))
            throw std::runtime_error("Symbolic-link platform path: " + relative);
        if (end == std::string::npos)
            break;
        offset = end + 1;
    } while (offset < relative.size());
    return result;
}

std::string random_nonce()
{
    std::random_device random;
    return std::to_string(random()) + "-" +
           std::to_string(std::chrono::steady_clock::now().time_since_epoch().count());
}

struct PublicationEntry {
    fs::path final;
    fs::path stage;
    fs::path previous;
    bool had_previous = false;
    bool remove_only = false;
};

fs::path journal_path(const fs::path& destination)
{
    return native_path_from_utf8(path_text(destination) + ".noveltea-publication-transaction.json");
}

void validate_parents(const fs::path& destination)
{
    if (!destination.is_absolute() || destination.filename().empty())
        throw std::runtime_error("Platform publication destination must be an absolute file path.");
    for (auto parent = destination.parent_path(); !parent.empty(); parent = parent.parent_path()) {
        const auto status = fs::symlink_status(parent);
        if (fs::is_symlink(status) || (fs::exists(status) && !fs::is_directory(status)))
            throw std::runtime_error("Unsafe platform output parent: " + path_text(parent));
        if (parent == parent.root_path())
            break;
    }
}

std::vector<PublicationEntry> journal_entries(const fs::path& destination, const Json& journal)
{
    if (journal.value("format", "") != "noveltea.native-platform-publication" ||
        journal.contains("formatVersion") || !journal.contains("nonce") ||
        !journal.at("nonce").is_string() || !journal.contains("accepted") ||
        !journal.at("accepted").is_boolean() || !journal.contains("outputs") ||
        !journal.at("outputs").is_array() || !journal.contains("rollingBack") ||
        !journal.at("rollingBack").is_boolean())
        throw std::runtime_error("Platform publication journal has an unsupported schema.");
    const auto nonce = journal.at("nonce").get<std::string>();
    if (nonce.empty() || nonce.size() > 70 ||
        !std::all_of(nonce.begin(), nonce.end(),
                     [](unsigned char c) { return (c >= '0' && c <= '9') || c == '-'; }))
        throw std::runtime_error("Platform publication journal has an invalid generation.");
    std::vector<PublicationEntry> entries;
    std::set<std::string> kinds;
    for (const auto& item : journal.at("outputs")) {
        if (!item.is_object() || !item.contains("kind") || !item.at("kind").is_string() ||
            !item.contains("hadPrevious") || !item.at("hadPrevious").is_boolean() ||
            !item.contains("removeOnly") || !item.at("removeOnly").is_boolean())
            throw std::runtime_error("Invalid platform publication journal entry.");
        const auto kind = item.at("kind").get<std::string>();
        if (!kinds.insert(kind).second ||
            (kind != "directory" && kind != "android-directory" && kind != "archive" &&
             kind != "symbols" && kind != "archive-tar" && kind != "symbols-tar" &&
             kind != "appimage" && kind != "mac-archive" && kind != "mac-symbols" &&
             kind != "mac-dmg" && kind != "mac-signing-report" && kind != "mac-manifest"))
            throw std::runtime_error("Invalid platform publication journal output kind.");
        const auto base = path_text(destination);
        const auto mac_base = base.ends_with(".app") ? base.substr(0, base.size() - 4) : base;
        const auto final =
            (kind == "directory" || kind == "android-directory") ? destination
            : kind == "archive"     ? native_path_from_utf8(base + ".zip")
            : kind == "archive-tar" ? native_path_from_utf8(base + ".tar.gz")
            : kind == "symbols-tar" ? native_path_from_utf8(base + "-symbols.tar.gz")
            : kind == "appimage"    ? native_path_from_utf8(base + ".AppImage")
            : kind == "mac-archive" ? native_path_from_utf8(mac_base + ".zip")
            : kind == "mac-symbols" ? native_path_from_utf8(mac_base + "-symbols.zip")
            : kind == "mac-dmg"     ? native_path_from_utf8(mac_base + ".dmg")
            : kind == "mac-signing-report"
                ? native_path_from_utf8(mac_base + "-signing-report.json")
            : kind == "mac-manifest" ? native_path_from_utf8(mac_base + "-export-manifest.json")
                                     : native_path_from_utf8(base + "-symbols.zip");
        if (kind != "symbols" && kind != "symbols-tar" && kind != "appimage" &&
            kind != "mac-symbols" && kind != "mac-dmg" && kind != "mac-signing-report" &&
            kind != "mac-manifest" && item.at("removeOnly").get<bool>())
            throw std::runtime_error("Cannot retire required platform artifact.");
        entries.push_back({final, native_path_from_utf8(path_text(final) + ".stage-" + nonce),
                           native_path_from_utf8(path_text(final) + ".previous-" + nonce),
                           item.at("hadPrevious").get<bool>(), item.at("removeOnly").get<bool>()});
    }
    if (kinds.size() == 1 && kinds.contains("android-directory"))
        return entries;
    if (kinds.size() < 2 || !kinds.contains("directory") ||
        (!kinds.contains("archive") && !kinds.contains("archive-tar") &&
         !kinds.contains("mac-archive")) ||
        (kinds.contains("archive") && kinds.contains("archive-tar")) ||
        (kinds.contains("mac-archive") &&
         (kinds.contains("archive") || kinds.contains("archive-tar") ||
          !path_text(destination).ends_with(".app"))) ||
        (kinds.contains("symbols") && kinds.contains("symbols-tar")))
        throw std::runtime_error("Platform publication journal omits required outputs.");
    return entries;
}

void remove_published_path(const fs::path& path)
{
    const auto status = fs::symlink_status(path);
    if (fs::is_symlink(status))
        throw std::runtime_error("Cannot clean symbolic-link publication path: " + path_text(path));
    if (fs::exists(status))
        fs::remove_all(path);
}

void recover_publication(const fs::path& destination)
{
    validate_parents(destination);
    const auto journal_file = journal_path(destination);
    const auto status = fs::symlink_status(journal_file);
    if (!fs::exists(status))
        return;
    if (!fs::is_regular_file(status) || fs::is_symlink(status))
        throw std::runtime_error("Unsafe platform publication journal.");
    const auto journal = Json::parse(read_file(journal_file));
    const auto entries = journal_entries(destination, journal);
    const bool accepted = journal.at("accepted").get<bool>();
    const bool rolling_back = journal.value("rollingBack", false);
    // Validate the entire transaction before touching any output. Otherwise
    // encountering an ambiguous backup after restoring another artifact can
    // leave the originally complete distribution partially rolled back.
    for (const auto& item : entries) {
        const bool is_directory = item.final == destination;
        const auto final_status = fs::symlink_status(item.final);
        const auto stage_status = fs::symlink_status(item.stage);
        const auto previous_status = fs::symlink_status(item.previous);
        const auto valid_member = [is_directory](fs::file_status status) {
            return !fs::exists(status) ||
                   (is_directory ? fs::is_directory(status) : fs::is_regular_file(status));
        };
        if (!valid_member(final_status) || !valid_member(stage_status) ||
            !valid_member(previous_status))
            throw std::runtime_error("Unsafe platform publication recovery member: " +
                                     path_text(item.final));
        // Retirement never produces a staged replacement. Its still-present
        // final file is the untouched incumbent until it is renamed to the
        // backup; requiring a stage here falsely rejects a safe rollback.
        if (item.remove_only && fs::exists(stage_status))
            throw std::runtime_error("Retired platform output has an unexpected stage: " +
                                     path_text(item.final));
        if (accepted) {
            if (!item.remove_only && !fs::exists(final_status))
                throw std::runtime_error("Accepted platform publication output is missing: " +
                                         path_text(item.final));
            if (item.remove_only && fs::exists(final_status))
                throw std::runtime_error("Accepted retired artifact is still present: " +
                                         path_text(item.final));
        } else if (item.had_previous) {
            if (!fs::exists(previous_status) &&
                (!fs::exists(final_status) ||
                 (!rolling_back && !item.remove_only && !fs::exists(stage_status))))
                throw std::runtime_error("Platform publication previous output cannot be proven: " +
                                         path_text(item.final));
        } else if (item.remove_only && fs::exists(final_status)) {
            // There was no incumbent to retire and removal-only has no stage.
            // A newly appeared symbols file is foreign, not our publication.
            throw std::runtime_error("Unexpected platform publication symbols incumbent: " +
                                     path_text(item.final));
        } else if (fs::exists(stage_status) && fs::exists(final_status)) {
            throw std::runtime_error("Unexpected platform publication incumbent: " +
                                     path_text(item.final));
        }
    }
    // An interrupted journal rewrite leaves a sibling .new-<nonce> file.
    // The destination lease excludes its former writer; clear only regular
    // orphan bytes after validating the full recovery state.
    const auto orphan = native_path_from_utf8(path_text(journal_file) + ".new-" +
                                              journal.at("nonce").get<std::string>());
    const auto orphan_status = fs::symlink_status(orphan);
    if (fs::exists(orphan_status)) {
        if (!fs::is_regular_file(orphan_status) || fs::is_symlink(orphan_status))
            throw std::runtime_error("Unsafe platform journal staging member.");
        fs::remove(orphan);
    }
    if (!accepted) {
        if (!rolling_back) {
            // Persist rollback intent BEFORE consuming the first backup. Once
            // recorded, an absent backup with a final output means this member
            // was restored by an earlier (possibly interrupted) rollback pass.
            auto marked = journal;
            marked["rollingBack"] = true;
            publish_atomic_file(journal_file, marked.dump(2) + '\n',
                                journal.at("nonce").get<std::string>());
        }
        // Reverse order to restore the previous complete artifact set.
        for (auto it = entries.rbegin(); it != entries.rend(); ++it) {
            const auto& item = *it;
            if (item.had_previous) {
                if (fs::exists(fs::symlink_status(item.previous))) {
                    remove_published_path(item.final);
                    fs::rename(item.previous, item.final);
                }
            } else if (!item.remove_only && !fs::exists(fs::symlink_status(item.stage))) {
                // A vanished stage without an incumbent means the rename
                // installed the new output before interruption.
                remove_published_path(item.final);
            }
        }
    }
    for (const auto& item : entries) {
        remove_published_path(item.stage);
        remove_published_path(item.previous);
    }
    fs::remove(journal_file);
    sync_directory(journal_file.parent_path());
}

class Staging {
public:
    Staging(std::vector<PublicationEntry> entries, fs::path journal)
        : entries_(std::move(entries)), journal_(std::move(journal))
    {
    }
    ~Staging()
    {
        // If rollback failed, keep the staged members alongside the journal
        // so later recovery still has the evidence needed to decide safely.
        std::error_code status_error;
        if (fs::exists(fs::symlink_status(journal_, status_error)) || status_error)
            return;
        for (const auto& item : entries_) {
            std::error_code ignored;
            fs::remove_all(item.stage, ignored);
        }
    }
    const std::vector<PublicationEntry>& entries() const { return entries_; }

private:
    std::vector<PublicationEntry> entries_;
    fs::path journal_;
};

void publish(const fs::path& destination, const std::vector<PublicationEntry>& entries,
             const std::string& nonce, const std::function<void()>& verify_activation)
{
    validate_parents(destination);
    const auto journal_file = journal_path(destination);
    if (fs::exists(fs::symlink_status(journal_file)))
        throw std::runtime_error("Unrecovered platform publication journal is present.");
    Json items = Json::array();
    for (const auto& entry : entries) {
        const std::string name = path_text(entry.final);
        const bool mac = path_text(destination).ends_with(".app");
        const std::string kind =
            entry.final == destination && entries.size() == 1 ? "android-directory"
            : entry.final == destination                      ? "directory"
            : mac && name.ends_with("-symbols.zip")           ? "mac-symbols"
            : mac && name.ends_with("-signing-report.json")   ? "mac-signing-report"
            : mac && name.ends_with("-export-manifest.json")  ? "mac-manifest"
            : mac && name.ends_with(".dmg")                   ? "mac-dmg"
            : mac && name.ends_with(".zip")                   ? "mac-archive"
            : name.ends_with("-symbols.zip")                  ? "symbols"
            : name.ends_with("-symbols.tar.gz")               ? "symbols-tar"
            : name.ends_with(".AppImage")                     ? "appimage"
            : name.ends_with(".tar.gz")                       ? "archive-tar"
                                                              : "archive";
        items.push_back({{"kind", kind},
                         {"hadPrevious", entry.had_previous},
                         {"removeOnly", entry.remove_only}});
    }
    Json journal{{"format", "noveltea.native-platform-publication"},
                 {"nonce", nonce},
                 {"accepted", false},
                 {"rollingBack", false},
                 {"outputs", items}};
    publish_atomic_file(journal_file, journal.dump(2) + '\n', nonce);
    try {
        for (const auto& item : entries) {
            validate_parents(destination);
            if (fs::is_symlink(fs::symlink_status(item.final)))
                throw std::runtime_error("Publication target changed to a symbolic link.");
            if (item.had_previous) {
                if (!fs::exists(fs::symlink_status(item.final)))
                    throw std::runtime_error("Publication incumbent disappeared.");
                fs::rename(item.final, item.previous);
                sync_directory(item.final.parent_path());
            } else if (fs::exists(fs::symlink_status(item.final))) {
                throw std::runtime_error("Publication target appeared after preflight.");
            }
            if (!item.remove_only)
                fs::rename(item.stage, item.final);
            sync_directory(item.final.parent_path());
        }
        // An artifact set is not accepted merely because every rename worked.
        // Read back the actual installed output and re-prove source identity
        // while the journal still permits a complete rollback.
        verify_activation();
        journal["accepted"] = true;
        publish_atomic_file(journal_file, journal.dump(2) + '\n', nonce);
    } catch (...) {
        recover_publication(destination);
        throw;
    }
    // New complete output is authoritative once accepted. An interrupted
    // backup cleanup is finished by the next mutating invocation.
    recover_publication(destination);
}

struct FileEntry {
    std::string path;
    std::string origin;
    std::string origin_id;
    std::uint32_t mode = 0644;
    std::uint64_t size = 0;
    std::string sha256;

    Json json() const
    {
        return {{"path", path}, {"origin", origin}, {"originId", origin_id},
                {"size", size}, {"mode", mode},     {"sha256", sha256}};
    }
};

FileEntry track_file(const fs::path& stage, std::string relative, std::string origin,
                     std::string origin_id, std::uint32_t mode)
{
    const auto file = safe_child(stage, relative);
    refuse_unsafe_entry(file);
    const auto bytes = read_file(file);
    return {std::move(relative),
            std::move(origin),
            std::move(origin_id),
            mode,
            static_cast<std::uint64_t>(bytes.size()),
            digest(bytes)};
}

void verify_archive(const fs::path& path, const fs::path& directory,
                    const std::vector<FileEntry>& files, std::string_view archive_prefix = {})
{
    struct ZipReader {
        std::ifstream file;
        mz_zip_archive archive{};
        bool initialized = false;
        explicit ZipReader(const fs::path& source) : file(source, std::ios::binary)
        {
            if (!file)
                throw std::runtime_error("Cannot open published ZIP archive.");
            archive.m_pIO_opaque = &file;
            archive.m_pRead = [](void* opaque, mz_uint64 offset, void* buffer,
                                 std::size_t length) -> std::size_t {
                auto& input = *static_cast<std::ifstream*>(opaque);
                if (offset >
                        static_cast<std::uint64_t>(std::numeric_limits<std::streamoff>::max()) ||
                    length > static_cast<std::size_t>(std::numeric_limits<std::streamsize>::max()))
                    return 0;
                input.clear();
                input.seekg(static_cast<std::streamoff>(offset));
                input.read(static_cast<char*>(buffer), static_cast<std::streamsize>(length));
                return static_cast<std::size_t>(input.gcount());
            };
            initialized = mz_zip_reader_init(&archive, fs::file_size(source), 0) != 0;
            if (!initialized)
                throw std::runtime_error("Published ZIP archive cannot be indexed.");
        }
        ~ZipReader()
        {
            if (initialized)
                mz_zip_reader_end(&archive);
        }
        ZipReader(const ZipReader&) = delete;
        ZipReader& operator=(const ZipReader&) = delete;
    } reader(path);
    if (mz_zip_reader_get_num_files(&reader.archive) != files.size())
        throw std::runtime_error("Published archive inventory could not be verified.");
    std::map<std::string, std::pair<mz_uint, std::uint64_t>> actual;
    for (mz_uint index = 0; index < files.size(); ++index) {
        mz_zip_archive_file_stat info{};
        if (!mz_zip_reader_file_stat(&reader.archive, index, &info) ||
            mz_zip_reader_is_file_a_directory(&reader.archive, index))
            throw std::runtime_error("Published archive contains an invalid file entry.");
        const auto name_length = mz_zip_reader_get_filename(&reader.archive, index, nullptr, 0);
        if (name_length == 0)
            throw std::runtime_error("Published archive contains an unnamed entry.");
        std::vector<char> name(static_cast<std::size_t>(name_length) + 1, '\0');
        if (!mz_zip_reader_get_filename(&reader.archive, index, name.data(),
                                        static_cast<mz_uint>(name.size())) ||
            !actual.emplace(name.data(), std::make_pair(index, info.m_uncomp_size)).second)
            throw std::runtime_error("Published archive contains duplicate or invalid paths.");
    }
    for (const auto& file : files) {
        const auto entry_name = std::string(archive_prefix) + file.path;
        if (!actual.contains(entry_name) || actual.at(entry_name).second != file.size)
            throw std::runtime_error("Published archive entry does not match inventory: " +
                                     file.path);
        const auto original = safe_child(directory, file.path);
        refuse_unsafe_entry(original);
        if (digest(read_file(original)) != file.sha256)
            throw std::runtime_error("Staged platform file changed: " + file.path);
        std::ifstream source(original, std::ios::binary);
        if (!source)
            throw std::runtime_error("Cannot open published archive entry: " + file.path);
        auto* iterator =
            mz_zip_reader_extract_iter_new(&reader.archive, actual.at(entry_name).first, 0);
        if (!iterator)
            throw std::runtime_error("Cannot decompress published archive entry: " + file.path);
        std::array<char, 65536> bytes{};
        std::array<char, 65536> comparison{};
        std::uint64_t total = 0;
        bool valid = true;
        while (true) {
            const auto chunk =
                mz_zip_reader_extract_iter_read(iterator, bytes.data(), bytes.size());
            if (chunk == 0)
                break;
            source.read(comparison.data(), static_cast<std::streamsize>(chunk));
            if (source.gcount() != static_cast<std::streamsize>(chunk) ||
                std::memcmp(bytes.data(), comparison.data(), chunk) != 0) {
                valid = false;
                break;
            }
            total += chunk;
        }
        if (mz_zip_peek_last_error(&reader.archive) != MZ_ZIP_NO_ERROR)
            valid = false;
        mz_zip_reader_extract_iter_free(iterator);
        if (!valid || total != file.size || source.peek() != std::char_traits<char>::eof())
            throw std::runtime_error("Published archive bytes differ from staging: " + file.path);
    }
}

void verify_distribution(const fs::path& directory, const fs::path& archive,
                         const std::vector<FileEntry>& files)
{
    std::set<std::string> expected;
    for (const auto& file : files)
        expected.insert(file.path);
    std::set<std::string> found;
    for (fs::recursive_directory_iterator it(directory), end; it != end; ++it) {
        const auto status = it->symlink_status();
        if (fs::is_symlink(status) || (!fs::is_directory(status) && !fs::is_regular_file(status)))
            throw std::runtime_error("Published distribution contains an unsafe filesystem entry.");
        if (fs::is_regular_file(status))
            found.insert(it->path().lexically_relative(directory).generic_string());
    }
    if (found != expected)
        throw std::runtime_error("Published distribution inventory does not match the manifest.");
    verify_archive(archive, directory, files);
}

void copy_verified_file(const fs::path& input, const fs::path& output)
{
    refuse_unsafe_entry(input);
    fs::create_directories(output.parent_path());
    fs::copy_file(input, output, fs::copy_options::none);
}

void put_u16(std::string& output, unsigned value)
{
    output += static_cast<char>(value & 255u);
    output += static_cast<char>((value >> 8u) & 255u);
}

void put_u32(std::string& output, std::uint32_t value)
{
    put_u16(output, value);
    put_u16(output, value >> 16u);
}

std::string make_ico(const std::vector<std::pair<unsigned, std::string>>& images)
{
    if (images.empty() || images.size() > 64)
        throw std::runtime_error("Windows icon sizes are missing.");
    std::string ico;
    put_u16(ico, 0);
    put_u16(ico, 1);
    put_u16(ico, static_cast<unsigned>(images.size()));
    std::uint32_t offset = static_cast<std::uint32_t>(6 + images.size() * 16);
    for (const auto& [size, bytes] : images) {
        if (size == 0 || size > 256 || bytes.empty())
            throw std::runtime_error("Invalid Windows icon image.");
        ico += static_cast<char>(size == 256 ? 0 : size);
        ico += static_cast<char>(size == 256 ? 0 : size);
        ico.push_back('\0');
        ico.push_back('\0');
        put_u16(ico, 1);
        put_u16(ico, 32);
        put_u32(ico, static_cast<std::uint32_t>(bytes.size()));
        put_u32(ico, offset);
        offset += static_cast<std::uint32_t>(bytes.size());
    }
    for (const auto& [size, bytes] : images) {
        (void)size;
        ico += bytes;
    }
    return ico;
}

std::uint64_t elf_integer(std::string_view bytes, std::uint64_t offset, unsigned length)
{
    if (offset > bytes.size() || length > bytes.size() - offset)
        throw std::runtime_error("Truncated Linux ELF player.");
    std::uint64_t value = 0;
    for (unsigned index = 0; index < length; ++index)
        value |= static_cast<std::uint64_t>(static_cast<unsigned char>(bytes[offset + index]))
                 << (index * 8u);
    return value;
}

struct ElfDependencies {
    std::set<std::string> needed;
    std::vector<std::string> rpaths;
};

// Inspect the actual x86_64 ELF dynamic segment, independently of template
// metadata. Virtual DT_STRTAB addresses are resolved through file-backed
// PT_LOAD segments; no loader or host readelf invocation is involved.
ElfDependencies inspect_linux_elf(std::string_view bytes)
{
    if (bytes.size() < 64 ||
        bytes.substr(0, 4) != std::string_view{"\x7f"
                                               "ELF",
                                               4} ||
        elf_integer(bytes, 4, 1) != 2 || elf_integer(bytes, 5, 1) != 1 ||
        elf_integer(bytes, 18, 2) != 62 ||
        (elf_integer(bytes, 16, 2) != 2 && elf_integer(bytes, 16, 2) != 3))
        throw std::runtime_error("Linux player must be a 64-bit little-endian x86_64 ELF.");
    struct Segment {
        std::uint64_t offset, vaddr, size;
    };
    std::vector<Segment> loads;
    std::optional<Segment> dynamic;
    const auto phoff = elf_integer(bytes, 32, 8);
    const auto phsize = elf_integer(bytes, 54, 2);
    const auto phcount = elf_integer(bytes, 56, 2);
    if (phsize < 56 || phcount == 0 || phcount > 512 || phoff > bytes.size() ||
        phcount > (bytes.size() - phoff) / phsize)
        throw std::runtime_error("Linux ELF has an invalid program-header table.");
    for (std::uint64_t index = 0; index < phcount; ++index) {
        const auto pos = phoff + index * phsize;
        const auto type = elf_integer(bytes, pos, 4);
        Segment segment{elf_integer(bytes, pos + 8, 8), elf_integer(bytes, pos + 16, 8),
                        elf_integer(bytes, pos + 32, 8)};
        if (segment.offset > bytes.size() || segment.size > bytes.size() - segment.offset)
            throw std::runtime_error("Linux ELF segment exceeds the player file.");
        if (type == 1)
            loads.push_back(segment);
        if (type == 2) {
            if (dynamic)
                throw std::runtime_error("Linux ELF has duplicate dynamic segments.");
            dynamic = segment;
        }
    }
    if (!dynamic || dynamic->size % 16 != 0)
        throw std::runtime_error("Linux player has no valid dynamic segment.");
    std::uint64_t string_address = 0, string_size = 0;
    std::vector<std::uint64_t> needed_offsets, rpath_offsets;
    bool terminated = false;
    for (std::uint64_t pos = dynamic->offset; pos < dynamic->offset + dynamic->size; pos += 16) {
        const auto tag = elf_integer(bytes, pos, 8);
        const auto value = elf_integer(bytes, pos + 8, 8);
        if (tag == 0) {
            terminated = true;
            break;
        }
        if (tag == 1)
            needed_offsets.push_back(value);
        if (tag == 5)
            string_address = value;
        if (tag == 10)
            string_size = value;
        if (tag == 15 || tag == 29)
            rpath_offsets.push_back(value);
    }
    if (!terminated || string_size == 0)
        throw std::runtime_error("Linux ELF dynamic string table is missing.");
    std::optional<std::uint64_t> string_offset;
    for (const auto& segment : loads)
        if (string_address >= segment.vaddr && string_address - segment.vaddr < segment.size &&
            string_size <= segment.size - (string_address - segment.vaddr)) {
            string_offset = segment.offset + string_address - segment.vaddr;
            break;
        }
    if (!string_offset)
        throw std::runtime_error("Linux ELF dynamic strings are not file-backed.");
    const auto string_at = [&](std::uint64_t offset) {
        if (offset >= string_size)
            throw std::runtime_error("Linux ELF contains an invalid dynamic string.");
        const auto begin = bytes.substr(*string_offset + offset, string_size - offset);
        const auto end = begin.find('\0');
        if (end == std::string_view::npos || end == 0)
            throw std::runtime_error("Linux ELF contains an unterminated dynamic string.");
        return std::string(begin.substr(0, end));
    };
    ElfDependencies result;
    for (const auto offset : needed_offsets)
        result.needed.insert(string_at(offset));
    for (const auto offset : rpath_offsets) {
        const auto combined = string_at(offset);
        std::size_t start = 0;
        do {
            const auto end = combined.find(':', start);
            result.rpaths.push_back(combined.substr(start, end - start));
            if (end == std::string::npos)
                break;
            start = end + 1;
        } while (true);
    }
    return result;
}

void verify_linux_dependencies(const Json& descriptor, const fs::path& player,
                               const std::map<std::string, fs::path>& libraries)
{
    if (!descriptor.contains("linuxNeeded") || !descriptor.at("linuxNeeded").is_array() ||
        !descriptor.contains("linuxRpaths") || !descriptor.at("linuxRpaths").is_array())
        throw std::runtime_error("Linux template is missing its ELF dependency declarations.");
    const auto elf = inspect_linux_elf(read_file(player));
    std::set<std::string> declared;
    for (const auto& item : descriptor.at("linuxNeeded"))
        declared.insert(item.get<std::string>());
    if (elf.needed != declared)
        throw std::runtime_error("Linux ELF NEEDED entries disagree with the template.");
    // Template descriptors contain the full readelf RUNPATH/RPATH string for
    // each ELF tag. The loader interprets colon-separated components.
    std::vector<std::string> declared_paths;
    for (const auto& item : descriptor.at("linuxRpaths")) {
        const auto combined = item.get<std::string>();
        std::size_t start = 0;
        while (true) {
            const auto end = combined.find(':', start);
            declared_paths.push_back(combined.substr(start, end - start));
            if (end == std::string::npos)
                break;
            start = end + 1;
        }
    }
    if (elf.rpaths != declared_paths)
        throw std::runtime_error("Linux ELF runtime paths disagree with the template.");
    const auto validate = [&](const fs::path& owner, const ElfDependencies& binary) {
        for (const auto& path : binary.rpaths)
            if (path.empty() || path[0] == '/' || path.find("..") != std::string::npos ||
                path.find('\\') != std::string::npos ||
                (path != "$ORIGIN" && !path.starts_with("$ORIGIN/")) ||
                path.find_first_of("\n\r") != std::string::npos)
                throw std::runtime_error("Linux ELF has a nonportable runtime search path: " +
                                         path);
        for (const auto& needed : binary.needed) {
            if (const auto bundled = libraries.find(needed); bundled != libraries.end()) {
                bool reachable = false;
                for (const auto& search_path : binary.rpaths) {
                    const auto candidate =
                        (owner.parent_path() /
                         native_path_from_utf8(search_path.size() > 7 ? search_path.substr(8)
                                                                      : std::string{}) /
                         native_path_from_utf8(needed))
                            .lexically_normal();
                    if (candidate == bundled->second.lexically_normal()) {
                        reachable = true;
                        break;
                    }
                }
                if (!reachable)
                    throw std::runtime_error("Linux ELF cannot resolve bundled library: " + needed);
                continue;
            }
            const std::array<std::string_view, 18> system_prefixes{
                "ld-linux",    "libc.so",      "libm.so",      "libdl.so", "libpthread.so",
                "librt.so",    "libgcc_s.so",  "libstdc++.so", "libX",     "libxcb",
                "libwayland-", "libxkbcommon", "libGL",        "libEGL",   "libdrm",
                "libasound",   "libpulse",     "libudev"};
            if (std::any_of(system_prefixes.begin(), system_prefixes.end(),
                            [&](auto prefix) { return needed.starts_with(prefix); }) ||
                needed.starts_with("libdbus-") || needed.starts_with("libfontconfig") ||
                needed.starts_with("libfreetype") || needed.starts_with("libz.so"))
                continue;
            throw std::runtime_error("Linux ELF has an unresolved non-system dependency: " +
                                     needed);
        }
    };
    validate(player, elf);
    // An ELF can load successfully while a transitive DT_NEEDED entry is
    // absent or in the wrong directory. Check the actual dynamic section and
    // origin-relative lookup of every shipped shared library as well.
    for (const auto& [name, path] : libraries) {
        (void)name;
        validate(path, inspect_linux_elf(read_file(path)));
    }
}

Json diagnostic(std::string code, std::string path, std::string message)
{
    return {{"code", std::move(code)},
            {"path", std::move(path)},
            {"severity", "error"},
            {"message", std::move(message)}};
}

PlatformCliResult failure(std::string code, std::string message, int exit = 4)
{
    const auto path = code == "WORKSPACE_REVISION_CONFLICT" ? "/output" : "/staging";
    return {{{"success", false},
             {"exitCode", exit},
             {"diagnostics", Json::array({diagnostic(std::move(code), path, message)})}},
            std::move(message)};
}

PlatformCliResult stage_web_export(const Json& admission, const Json& profile,
                                   const Json& descriptor, const fs::path& template_directory,
                                   const fs::path& icon_source, const fs::path& destination,
                                   bool force, bool allow_localization_warnings,
                                   bool include_unused_assets, bool include_shader_sources,
                                   const PlatformPublicationLock& lock,
                                   const PlatformExportTools& tools,
                                   const std::function<bool()>& source_current)
{
    if (lock.destination() != destination)
        return failure("WORKSPACE_TRANSACTION_RECOVERY_CONFLICT",
                       "Web publication requires exclusive output ownership.", 5);
    if (!tools.prepare_package || !tools.create_archive || !tools.resize_image ||
        !tools.physical_sources_current)
        return failure("CLI_INTERNAL", "Native Web export tools are unavailable.", 70);
    try {
        check_cancellation(tools);
        if (!source_current())
            return failure("WORKSPACE_REVISION_CONFLICT", "Web sources changed.", 5);
        const auto& app = admission.at("project").at("settings").at("app");
        const auto& web = profile.at("web");
        const auto& base = web.at("basePath").get_ref<const std::string&>();
        if (base.empty() || base.front() != '/' || base.back() != '/' ||
            base.find("//") != std::string::npos || base.find("..") != std::string::npos ||
            base.find_first_of("\"<>\\?#") != std::string::npos)
            return failure("platform-web-base-path", "Web base path is not safe for deployment.");
        if (web.value("artifact", "") != "directory-zip")
            return failure("CLI_NATIVE_CANDIDATE_UNCLAIMED",
                           "Native Web exporter requires directory-zip output.", 70);
        const auto app_id = app.at("applicationId").get<std::string>();
        const auto app_name = app.at("displayName").get<std::string>();
        const auto version = app.at("versionName").get<std::string>();
        const auto save_namespace = app.at("saveNamespace").get<std::string>();
        const auto icon_sha = digest(read_file(icon_source));
        const auto descriptor_sha = digest(read_file(template_directory / "template.json"));
        const auto registry_sha = digest(read_file(template_directory / ".noveltea-template.json"));
        if (Json::parse(read_file(template_directory / "template.json")) != descriptor)
            return failure("platform-template-changed", "Web template changed after preflight.", 5);

        const auto nonce = random_nonce();
        const auto archive_path = native_path_from_utf8(path_text(destination) + ".zip");
        const std::vector<PublicationEntry> entries{
            {destination, native_path_from_utf8(path_text(destination) + ".stage-" + nonce),
             native_path_from_utf8(path_text(destination) + ".previous-" + nonce),
             fs::exists(fs::symlink_status(destination))},
            {archive_path, native_path_from_utf8(path_text(archive_path) + ".stage-" + nonce),
             native_path_from_utf8(path_text(archive_path) + ".previous-" + nonce),
             fs::exists(fs::symlink_status(archive_path))}};
        for (const auto& entry : entries)
            if (fs::exists(fs::symlink_status(entry.stage)) ||
                fs::exists(fs::symlink_status(entry.previous)) ||
                fs::is_symlink(fs::symlink_status(entry.final)) || (entry.had_previous && !force))
                return failure("platform-output-exists", "Web staging or output path is unsafe.");
        fs::create_directories(destination.parent_path());
        Staging cleanup(entries, journal_path(destination));
        fs::create_directory(entries.front().stage);
        const auto& stage = entries.front().stage;
        Json native_profile = admission.at("profile");
        native_profile["shaderVariants"] = Json::array({"essl-300"});
        native_profile["localization"] = profile.at("localization");
        native_profile["excludeUnusedAssets"] =
            include_unused_assets ? false : profile.value("excludeUnusedAssets", true);
        native_profile["includeShaderSources"] =
            include_shader_sources || profile.value("includeShaderSources", false);
        native_profile["stripShaderSources"] =
            !native_profile.at("includeShaderSources").get<bool>();
        if (tools.progress)
            tools.progress("writing-package", "Preparing native Web runtime package (essl-300)");
        const auto packaged =
            tools.prepare_package(admission, native_profile, stage / "game.ntpkg");
        check_cancellation(tools);
        if (!packaged.value("ok", false))
            return failure(packaged.value("code", "native.platform.package"),
                           packaged.value("error", "Web runtime package failed."),
                           packaged.value("code", "") == "WORKSPACE_REVISION_CONFLICT" ? 5 : 6);
        const auto& artifact = packaged.at("artifact");
        if (!artifact.contains("compiledProject") ||
            artifact.at("packageOptions").value("kind", "") != "runtime")
            return failure("native.runtime.artifact", "Native Web runtime evidence is invalid.", 6);
        const auto& package_options = artifact.at("packageOptions");
        for (const auto& finding : artifact.value("diagnostics", Json::array()))
            if (finding.value("severity", "") == "warning" &&
                finding.value("code", std::string{}).starts_with("localization.export.") &&
                !allow_localization_warnings)
                return failure("localization.export.warning_override_required",
                               "Localization warnings require --allow-localization-warnings.");

        std::vector<FileEntry> files;
        files.push_back(track_file(stage, "game.ntpkg", "runtime-package", "game.ntpkg", 0644));
        const auto package_sha = files.back().sha256;
        const std::set<std::string> reserved{
            "game.ntpkg",        "player.json",   "index.html",          "manifest.webmanifest",
            "service-worker.js", "DEPLOYMENT.md", "export-manifest.json"};
        std::set<std::string> names;
        std::map<std::string, std::string> dependency_origins;
        for (const auto& dependency : descriptor.at("runtimeDependencies")) {
            const auto kind = dependency.value("kind", "");
            dependency_origins[dependency.at("path").get<std::string>()] =
                kind == "notice"    ? "notice"
                : kind == "library" ? "native-dependency"
                                    : "system-asset";
        }
        if (tools.progress)
            tools.progress("staging", "Copying and verifying Web player and template dependencies");
        for (const auto& declared : descriptor.at("files")) {
            check_cancellation(tools);
            const auto name = declared.at("path").get<std::string>();
            if (!names.insert(name).second || reserved.contains(name) ||
                name.starts_with("icons/web/"))
                return failure("platform-template-collision",
                               "Web template collides with an output: " + name);
            const auto source = safe_child(template_directory, name);
            if (!fs::is_regular_file(fs::symlink_status(source)) ||
                fs::file_size(source) != declared.at("size").get<std::uint64_t>() ||
                digest(read_file(source)) != declared.at("sha256").get<std::string>())
                return failure("invalid-installed-template", "Web template file changed: " + name,
                               5);
            copy_verified_file(source, safe_child(stage, name));
            const auto mode = declared.at("mode").get<std::uint32_t>();
            const auto origin_it = dependency_origins.find(name);
            const auto origin =
                origin_it == dependency_origins.end() ? "template" : origin_it->second;
            files.push_back(track_file(stage, name, origin,
                                       "template:" + descriptor.at("templateId").get<std::string>(),
                                       mode));
            if (files.back().sha256 != declared.at("sha256").get<std::string>())
                return failure("invalid-installed-template", "Web template copy changed.", 5);
            if (name.starts_with("licenses/")) {
                const auto mounted = "assets/system/" + name;
                if (!names.insert(mounted).second)
                    return failure("platform-template-collision", "Web system licenses collide.");
                copy_verified_file(source, safe_child(stage, mounted));
                files.push_back(track_file(stage, mounted, "system-asset", name, mode));
            }
        }
        // Browser loading uses stable well-known filenames only as Emscripten
        // lookup keys; downloaded paths are content-addressed at the root.
        auto hash_asset = [&](FileEntry& entry) {
            const auto source = safe_child(stage, entry.path);
            const auto extension = source.extension().string();
            const auto filename =
                source.stem().string() + "." + entry.sha256.substr(0, 16) + extension;
            const auto target = safe_child(stage, filename);
            if (fs::exists(fs::symlink_status(target)))
                throw std::runtime_error(
                    "Web content-addressed asset collides with a template file.");
            fs::rename(source, target);
            entry.path = filename;
        };
        std::array<std::string, 3> runtime_names{"player.js", "player.wasm", "player.data"};
        std::array<std::string, 3> hashed_runtime{};
        for (std::size_t index = 0; index < runtime_names.size(); ++index) {
            auto found = std::find_if(files.begin(), files.end(), [&](const FileEntry& file) {
                return file.path == runtime_names[index] ||
                       path_text(native_path_from_utf8(file.path).filename()) ==
                           runtime_names[index];
            });
            if (found == files.end() || found->origin == "runtime-package")
                return failure("platform-template-player",
                               "Web template lacks " + runtime_names[index]);
            hash_asset(*found);
            hashed_runtime[index] = found->path;
        }
        hash_asset(files.front());
        const auto package_path = files.front().path;
        const std::string template_id = descriptor.at("templateId").get<std::string>();
        if (tools.progress)
            tools.progress("generating-metadata",
                           "Generating Web icons, manifest and browser shell");
        std::vector<std::pair<unsigned, std::string>> favicon_images;
        Json web_icons = Json::array();
        std::vector<std::string> icon_names;
        for (const unsigned size : {16u, 32u, 180u, 192u, 512u}) {
            check_cancellation(tools);
            const auto temporary = stage / (".web-icon-" + std::to_string(size) + ".png");
            const auto resized = tools.resize_image({{"sourcePath", path_text(icon_source)},
                                                     {"outputPath", path_text(temporary)},
                                                     {"size", size}});
            if (!resized.value("ok", false))
                return failure("platform-icon-generation",
                               resized.value("error", "Web icon resize failed."));
            const auto bytes = read_file(temporary);
            fs::remove(temporary);
            if (size == 16 || size == 32)
                favicon_images.emplace_back(size, bytes);
            const auto name = "icons/web/icons/icon-" + std::to_string(size) + "." +
                              digest(bytes).substr(0, 16) + ".png";
            write_file(safe_child(stage, name), bytes);
            files.push_back(track_file(stage, name, "icon", "web-icon", 0644));
            icon_names.push_back(name);
            if (size == 192 || size == 512)
                web_icons.push_back({{"src", base + name},
                                     {"sizes", std::to_string(size) + "x" + std::to_string(size)},
                                     {"type", "image/png"},
                                     {"purpose", "any maskable"}});
        }
        const auto ico = make_ico(favicon_images);
        const auto favicon = "icons/web/favicon." + digest(ico).substr(0, 16) + ".ico";
        write_file(safe_child(stage, favicon), ico);
        files.push_back(track_file(stage, favicon, "icon", "web-favicon", 0644));
        icon_names.push_back(favicon);

        const auto& memory = profile.at("assetMemory");
        if (memory.value("kind", "") != "builtin")
            return failure("platform-asset-memory-policy",
                           "Native Web export does not yet support custom asset memory policies.",
                           70);
        const auto preset = memory.at("preset").get<std::string>();
        const std::map<std::string, std::array<std::uint64_t, 7>> baselines{
            {"low", {67108864, 671088640, 33554432, 33554432, 13421772, 536870912, 6710886}},
            {"balanced",
             {134217728, 1342177280, 67108864, 67108864, 40265318, 1073741824, 20132659}},
            {"high",
             {268435456, 2684354560, 134217728, 134217728, 107374182, 2147483648, 53687091}}};
        if (!baselines.contains(preset))
            return failure("platform-asset-memory-policy", "Unknown Web memory preset.");
        const auto& amounts = baselines.at(preset);
        Json asset_memory{{"preset", preset},
                          {"preparedCpuBytes", amounts[0]},
                          {"gpuBytes", amounts[1]},
                          {"audioBytes", amounts[2]},
                          {"temporaryBytes", amounts[3]},
                          {"warmPreparedCpuBytes", amounts[4]},
                          {"warmGpuBytes", amounts[5]},
                          {"warmAudioBytes", amounts[6]}};
        const auto& raw_display = package_options.at("display");
        const auto& raw_accessibility = package_options.at("accessibility");
        Json display{{"referenceResolution", raw_display.at("reference_resolution")},
                     {"worldRasterPolicy", raw_display.at("world_raster_policy")},
                     {"barColor", raw_display.at("bar_color")}};
        Json accessibility{{"uiScale", raw_accessibility.at("ui_scale")},
                           {"textScale", raw_accessibility.at("text_scale")}};
        Json player{{"format", "noveltea.player-config"},
                    {"formatVersion", 1},
                    {"displayName", app_name},
                    {"applicationId", app_id},
                    {"saveNamespace", save_namespace},
                    {"versionName", version},
                    {"package", {{"path", package_path}, {"sha256", package_sha}}},
                    {"capabilities", Json::array({"external-url"})},
                    {"display", display},
                    {"accessibility", accessibility},
                    {"assetMemory", asset_memory}};
        if (app.contains("defaultLocale") && app.at("defaultLocale").is_string())
            player["defaultLocale"] = app.at("defaultLocale");
        write_file(stage / "player.json", player.dump(2) + '\n');
        files.push_back(
            track_file(stage, "player.json", "generated-metadata", "player-config", 0644));
        const auto& resolution = display.at("referenceResolution");
        const auto width = resolution.at("width").get<int>();
        const auto height = resolution.at("height").get<int>();
        if (width <= 0 || height <= 0)
            return failure("platform-runtime-display", "Web display resolution is invalid.");
        const auto divisor = std::gcd(width, height);
        Json geometry{{"aspectRatio", {{"width", width / divisor}, {"height", height / divisor}}},
                      {"orientation", width >= height ? "landscape" : "portrait"},
                      {"barColor", display.at("barColor")}};
        const auto orientation = width >= height ? "landscape" : "portrait";
        const auto optional_string = [&](const Json& owner, std::string_view key,
                                         std::string fallback) {
            const auto it = owner.find(std::string(key));
            return it != owner.end() && it->is_string() ? it->get<std::string>() : fallback;
        };
        const auto locale = optional_string(app, "defaultLocale", "en");
        const auto theme = optional_string(app, "themeColor", "#111827");
        const auto background = optional_string(app, "launchBackgroundColor", "#000000");
        auto encoded_id = app_id;
        for (auto& character : encoded_id)
            if (character == ' ')
                character = '_';
        Json manifest{{"id", optional_string(app.at("web"), "manifestId", "/" + encoded_id)},
                      {"name", app_name},
                      {"short_name", optional_string(app, "shortName", app_name)},
                      {"start_url", base},
                      {"scope", base},
                      {"display", web.at("display")},
                      {"orientation", orientation},
                      {"theme_color", theme},
                      {"background_color", background},
                      {"icons", web_icons}};
        if (app.contains("defaultLocale") && app.at("defaultLocale").is_string())
            manifest["lang"] = app.at("defaultLocale");
        write_file(stage / "manifest.webmanifest", manifest.dump(2) + '\n');
        files.push_back(
            track_file(stage, "manifest.webmanifest", "web-manifest", "web-manifest", 0644));

        std::vector<std::string> immutable{hashed_runtime[0], hashed_runtime[1], hashed_runtime[2],
                                           package_path};
        for (const auto& file : files)
            if (file.path.starts_with("assets/system/licenses/"))
                immutable.push_back(file.path);
        immutable.insert(immutable.end(), icon_names.begin(), icon_names.end());
        std::string concatenated;
        for (const auto& path : immutable) {
            const auto it = std::find_if(files.begin(), files.end(),
                                         [&](const FileEntry& file) { return file.path == path; });
            if (it == files.end())
                throw std::runtime_error("Web offline asset inventory is incomplete.");
            concatenated += it->sha256;
        }
        const auto offline = web.value("pwa", false) && web.value("serviceWorker", "") == "offline";
        if (offline) {
            std::string prefix = "noveltea-" + app_id + "-";
            for (auto& character : prefix)
                if (!std::isalnum(static_cast<unsigned char>(character)) && character != '_' &&
                    character != '.' && character != '-')
                    character = '_';
            Json assets =
                Json::array({"./", "./index.html", "./player.json", "./manifest.webmanifest"});
            for (const auto& path : immutable)
                assets.push_back("./" + path);
            std::string worker =
                "const CACHE = " + web_shell_json(prefix + digest(concatenated).substr(0, 20)) +
                ";\nconst PREFIX = " + web_shell_json(prefix) +
                ";\nconst ASSETS = " + assets.dump() + ";\n" +
                "self.addEventListener('install', event => "
                "event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(ASSETS)).then(() => "
                "self.skipWaiting())));\n"
                "self.addEventListener('activate', event => "
                "event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => "
                "key.startsWith(PREFIX) && key !== CACHE).map(key => caches.delete(key)))).then(() "
                "=> self.clients.claim())));\n"
                "self.addEventListener('fetch', event => { if (event.request.method === 'GET') "
                "event.respondWith(caches.match(event.request).then(hit => hit || "
                "fetch(event.request))); });\n";
            write_file(stage / "service-worker.js", worker);
            files.push_back(track_file(stage, "service-worker.js", "web-service-worker",
                                       "service-worker", 0644));
        }
        write_file(stage / "index.html",
                   web_player_shell(app_name, locale, theme, background, base, favicon,
                                    hashed_runtime[0], hashed_runtime[1], hashed_runtime[2],
                                    offline));
        files.push_back(track_file(stage, "index.html", "web-shell", "web-shell", 0644));
        std::string deployment =
            "# Web deployment\n\nServe this directory over HTTPS (localhost is also accepted by "
            "browsers). Opening index.html through file:// is unsupported.\n\nBase path: `" +
            base +
            "`\n\nRequired MIME types:\n- .wasm: application/wasm\n- .js: text/javascript\n- "
            ".ntpkg: application/octet-stream\n- .webmanifest: application/manifest+json\n\nUse "
            "long-lived immutable caching for content-hashed .js, .wasm, .ntpkg, and icon files. "
            "Serve index.html, player.json, and manifest.webmanifest with revalidation. Enable "
            "Brotli or gzip compression for JavaScript and Wasm.\n\nHTTPS required: ";
        deployment += web.value("pwa", false) ? "yes (PWA/service-worker behavior)" : "recommended";
        deployment += "\nService worker: ";
        deployment += offline ? "offline cache enabled" : "disabled";
        deployment += "\nCross-origin isolation: ";
        const auto threaded = web.value("threaded", false);
        deployment += threaded ? "required" : "not required";
        deployment += "\n";
        if (threaded)
            deployment += "Required response headers:\n- Cross-Origin-Opener-Policy: "
                          "same-origin\n- Cross-Origin-Embedder-Policy: require-corp\n- "
                          "Cross-Origin-Resource-Policy: same-origin\n";
        write_file(stage / "DEPLOYMENT.md", deployment);
        files.push_back(
            track_file(stage, "DEPLOYMENT.md", "web-deployment", "web-deployment", 0644));

        Json deployment_model{{"target", "web"},
                              {"architecture", profile.at("architecture")},
                              {"buildFlavor", profile.at("buildFlavor")},
                              {"applicationId", app_id},
                              {"displayName", app_name},
                              {"versionName", version},
                              {"saveNamespace", save_namespace},
                              {"capabilities", Json::array({"external-url"})},
                              {"capabilityMetadata",
                               {{"androidPermissions", Json::array()},
                                {"androidFeatures", Json::array()},
                                {"webRequirements", Json::array({"external-navigation"})},
                                {"desktopFeatures", Json::array()}}},
                              {"display", geometry},
                              {"packageAccess", profile.at("packageAccess")},
                              {"templateId", descriptor.at("templateId")},
                              {"buildId", descriptor.at("buildId")},
                              {"compiledProjectFormatVersion", 1},
                              {"playerRuntimeApiVersion", 1},
                              {"assetMemory", asset_memory}};
        std::sort(files.begin(), files.end(),
                  [](const FileEntry& a, const FileEntry& b) { return a.path < b.path; });
        Json inventory = Json::array();
        for (const auto& file : files)
            inventory.push_back(file.json());
        write_file(stage / "export-manifest.json",
                   Json{{"format", "noveltea.platform-export-manifest"},
                        {"deployment", deployment_model},
                        {"files", inventory}}
                           .dump(2) +
                       '\n');
        files.push_back(track_file(stage, "export-manifest.json", "generated-metadata",
                                   "export-manifest", 0644));
        Json archive_entries = Json::array();
        for (const auto& file : files)
            archive_entries.push_back({{"sourcePath", path_text(safe_child(stage, file.path))},
                                       {"archivePath", file.path},
                                       {"size", file.size},
                                       {"mode", file.mode}});
        if (tools.progress)
            tools.progress("finalizing", "Building reproducible Web distribution ZIP");
        const auto archived =
            tools.create_archive({{"outputPath", path_text(entries[1].stage)},
                                  {"format", "zip"},
                                  {"compression", profile.value("compression", "default")},
                                  {"entries", archive_entries}});
        check_cancellation(tools);
        if (!archived.value("ok", false))
            return failure("platform-archive-failed", archived.value("error", "Web ZIP failed."));
        const auto verify_sources = [&]() {
            if (!source_current() || !tools.physical_sources_current(package_options) ||
                digest(read_file(icon_source)) != icon_sha)
                throw SourceChanged("Web source generation or physical assets changed.");
            if (digest(read_file(template_directory / "template.json")) != descriptor_sha ||
                digest(read_file(template_directory / ".noveltea-template.json")) != registry_sha)
                throw SourceChanged("Web template registry changed during export.");
            for (const auto& declared : descriptor.at("files")) {
                const auto source =
                    safe_child(template_directory, declared.at("path").get<std::string>());
                if (!fs::is_regular_file(fs::symlink_status(source)) ||
                    digest(read_file(source)) != declared.at("sha256").get<std::string>())
                    throw SourceChanged("Web player template changed during export.");
            }
        };
        if (tools.progress)
            tools.progress("verifying", "Verifying Web outputs and source freshness");
        check_cancellation(tools);
        verify_sources();
        publish(destination, entries, nonce, [&]() {
            check_cancellation(tools);
            verify_distribution(destination, archive_path, files);
            verify_sources();
            check_cancellation(tools);
        });
        Json artifacts = Json::array({{{"kind", "directory"}, {"path", path_text(destination)}},
                                      {{"kind", "archive"},
                                       {"path", path_text(archive_path)},
                                       {"size", fs::file_size(archive_path)}}});
        return {{{"success", true},
                 {"exitCode", 0},
                 {"diagnostics", Json::array()},
                 {"outputDirectory", path_text(destination)},
                 {"archivePath", path_text(archive_path)},
                 {"templateToken", template_id + "@" + descriptor.at("buildId").get<std::string>()},
                 {"signingRequested", false},
                 {"signingApplied", false},
                 {"cancelled", false},
                 {"artifacts", std::move(artifacts)},
                 {"deployment", deployment_model}},
                "Native Web platform export succeeded."};
    } catch (const ExportCancelled& error) {
        auto cancelled = failure("export-cancelled", error.what(), 130);
        cancelled.envelope["cancelled"] = true;
        return cancelled;
    } catch (const SourceChanged& error) {
        return failure("WORKSPACE_REVISION_CONFLICT", error.what(), 5);
    } catch (const std::exception& error) {
        return failure("platform-export-failed", error.what());
    }
}

PlatformCliResult stage_linux_export(const Json& admission, const Json& profile,
                                     const Json& descriptor, const fs::path& template_directory,
                                     const fs::path& icon_source, const fs::path& destination,
                                     bool force, bool allow_localization_warnings,
                                     bool include_unused_assets, bool include_shader_sources,
                                     const PlatformExportTools& tools,
                                     const std::function<bool()>& source_current)
{
    if (!tools.prepare_package || !tools.create_archive || !tools.resize_image ||
        !tools.physical_sources_current)
        return failure("CLI_INTERNAL", "Native Linux export tools are unavailable.", 70);
    try {
        check_cancellation(tools);
        if (!source_current())
            return failure("WORKSPACE_REVISION_CONFLICT", "Linux sources changed.", 5);
        const auto& app = admission.at("project").at("settings").at("app");
        const auto& desktop = profile.at("desktop");
        const auto executable = desktop.at("executableName").get<std::string>();
        if (executable.empty() || executable == "." || executable == ".." ||
            !std::all_of(executable.begin(), executable.end(), [](unsigned char ch) {
                return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') ||
                       (ch >= '0' && ch <= '9') || ch == '.' || ch == '_' || ch == '+' || ch == '-';
            }))
            return failure("platform-executable-name-invalid", "Invalid Linux executable name.");
        const auto kind = desktop.at("artifact").get<std::string>();
        if (kind != "zip" && kind != "tar" && kind != "tar.gz" && kind != "appimage")
            return failure("platform-artifact-invalid", "Unsupported Linux export artifact.");
        const auto archive_format = kind == "zip" ? "zip" : "tar.gz";
        const auto appimage = kind == "appimage";
        const auto app_id = app.at("applicationId").get<std::string>();
        const auto app_name = app.at("displayName").get<std::string>();
        const auto version = app.at("versionName").get<std::string>();
        const auto save_namespace = app.at("saveNamespace").get<std::string>();
        const auto desktop_id =
            app.value("desktop", Json::object()).value("linuxDesktopId", app_id);
        if (desktop_id.empty() || desktop_id.front() == '.' || desktop_id.back() == '.' ||
            desktop_id.find('.') == std::string::npos ||
            !std::all_of(desktop_id.begin(), desktop_id.end(),
                         [](unsigned char ch) {
                             return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') ||
                                    (ch >= '0' && ch <= '9') || ch == '.' || ch == '_' || ch == '-';
                         }) ||
            desktop_id.find("..") != std::string::npos)
            return failure("platform-desktop-id-invalid", "Invalid Linux desktop application ID.");
        const auto icon_sha = digest(read_file(icon_source));
        const auto descriptor_sha = digest(read_file(template_directory / "template.json"));
        const auto registry_sha = digest(read_file(template_directory / ".noveltea-template.json"));
        if (Json::parse(read_file(template_directory / "template.json")) != descriptor)
            return failure("platform-template-changed", "Linux template changed after preflight.",
                           5);

        const auto nonce = random_nonce();
        const auto archive_path =
            native_path_from_utf8(path_text(destination) +
                                  (archive_format == std::string_view{"zip"} ? ".zip" : ".tar.gz"));
        const auto symbols_path = native_path_from_utf8(path_text(destination) + "-symbols.tar.gz");
        const auto appimage_path = native_path_from_utf8(path_text(destination) + ".AppImage");
        const bool with_symbols = profile.value("includeDebugSymbols", false);
        const auto make_entry = [&](const fs::path& final, bool retire = false) {
            return PublicationEntry{final,
                                    native_path_from_utf8(path_text(final) + ".stage-" + nonce),
                                    native_path_from_utf8(path_text(final) + ".previous-" + nonce),
                                    fs::exists(fs::symlink_status(final)), retire};
        };
        std::vector<PublicationEntry> entries{make_entry(destination), make_entry(archive_path),
                                              make_entry(symbols_path, !with_symbols),
                                              make_entry(appimage_path, !appimage)};
        for (const auto& entry : entries)
            if (fs::exists(fs::symlink_status(entry.stage)) ||
                fs::exists(fs::symlink_status(entry.previous)) ||
                fs::is_symlink(fs::symlink_status(entry.final)) || (entry.had_previous && !force))
                return failure("platform-output-exists",
                               "Linux output path is unsafe or occupied.");
        fs::create_directories(destination.parent_path());
        Staging cleanup(entries, journal_path(destination));
        fs::create_directory(entries.front().stage);
        const auto& stage = entries.front().stage;

        Json native_profile = admission.at("profile");
        native_profile["shaderVariants"] = Json::array({"glsl-330"});
        native_profile["localization"] = profile.at("localization");
        native_profile["excludeUnusedAssets"] =
            include_unused_assets ? false : profile.value("excludeUnusedAssets", true);
        native_profile["includeShaderSources"] =
            include_shader_sources || profile.value("includeShaderSources", false);
        native_profile["stripShaderSources"] =
            !native_profile.at("includeShaderSources").get<bool>();
        if (tools.progress)
            tools.progress("writing-package", "Preparing Linux runtime package (glsl-330)");
        const auto packaged =
            tools.prepare_package(admission, native_profile, stage / "game.ntpkg");
        check_cancellation(tools);
        if (!packaged.value("ok", false))
            return failure(packaged.value("code", "native.platform.package"),
                           packaged.value("error", "Linux runtime package failed."),
                           packaged.value("code", "") == "WORKSPACE_REVISION_CONFLICT" ? 5 : 6);
        const auto& artifact = packaged.at("artifact");
        if (!artifact.contains("compiledProject") ||
            artifact.at("packageOptions").value("kind", "") != "runtime")
            return failure("native.runtime.artifact", "Linux runtime package evidence is invalid.",
                           6);
        const auto& options = artifact.at("packageOptions");
        for (const auto& diagnostic : artifact.value("diagnostics", Json::array()))
            if (diagnostic.value("severity", "") == "warning" &&
                diagnostic.value("code", std::string{}).starts_with("localization.export.") &&
                !allow_localization_warnings)
                return failure("localization.export.warning_override_required",
                               "Localization warnings require --allow-localization-warnings.");

        std::vector<FileEntry> files, symbols;
        std::set<std::string> names{"game.ntpkg"};
        std::map<std::string, fs::path> libraries;
        std::map<std::string, std::string> origins;
        for (const auto& dependency : descriptor.at("runtimeDependencies")) {
            const auto name = dependency.at("path").get<std::string>();
            const auto category = dependency.value("kind", "");
            origins[name] = category == "notice"    ? "notice"
                            : category == "library" ? "native-dependency"
                                                    : "system-asset";
            if (category == "library" && name.find(".so") != std::string::npos) {
                const auto basename = native_path_from_utf8(name).filename().string();
                if (!libraries.emplace(basename, safe_child(stage, name)).second)
                    return failure("platform-template-dependencies",
                                   "Ambiguous Linux shared library name: " + basename);
            }
        }
        std::string player_path;
        if (tools.progress)
            tools.progress("staging", "Staging Linux player and verified dependencies");
        for (const auto& declared : descriptor.at("files")) {
            check_cancellation(tools);
            const auto name = declared.at("path").get<std::string>();
            if (!names.insert(name).second || name == "player.json" ||
                name == "export-manifest.json" || name == "LINUX_METADATA.json" ||
                name.starts_with("share/applications/") || name.starts_with("share/icons/"))
                return failure("platform-template-collision",
                               "Linux template output collision: " + name);
            const auto source = safe_child(template_directory, name);
            if (!fs::is_regular_file(fs::symlink_status(source)) ||
                fs::file_size(source) != declared.at("size").get<std::uint64_t>() ||
                digest(read_file(source)) != declared.at("sha256").get<std::string>())
                return failure("invalid-installed-template", "Linux template file changed: " + name,
                               5);
            const auto mode = declared.at("mode").get<std::uint32_t>();
            const auto role = declared.value("role", "");
            if (role == "symbol" || name.ends_with(".debug")) {
                symbols.push_back({name, "symbol", name, mode,
                                   declared.at("size").get<std::uint64_t>(),
                                   declared.at("sha256").get<std::string>()});
                continue;
            }
            if (role == "player") {
                if (!player_path.empty() || !(mode & 0111))
                    return failure("platform-template-player", "Invalid Linux player declaration.");
                player_path = name;
            }
            const auto target = safe_child(stage, name);
            copy_verified_file(source, target);
            fs::permissions(target, static_cast<fs::perms>(mode & 0777), fs::perm_options::replace);
            files.push_back(
                track_file(stage, name, origins.contains(name) ? origins.at(name) : "template",
                           "template:" + descriptor.at("templateId").get<std::string>(), mode));
            if (files.back().sha256 != declared.at("sha256").get<std::string>())
                return failure("invalid-installed-template", "Linux template copy changed.", 5);
            if (name.starts_with("licenses/")) {
                const auto mounted = "assets/system/" + name;
                if (!names.insert(mounted).second)
                    return failure("platform-template-collision", "Linux license mount collides.");
                copy_verified_file(target, safe_child(stage, mounted));
                files.push_back(track_file(stage, mounted, "system-asset", name, mode));
            }
        }
        if (player_path.empty())
            return failure("platform-template-player", "Linux template has no player.");
        const auto binary_target =
            (native_path_from_utf8(player_path).parent_path() / native_path_from_utf8(executable))
                .generic_string();
        if (binary_target == executable ||
            (binary_target != player_path && names.contains(binary_target)))
            return failure("platform-template-collision", "Linux launcher collides with player.");
        auto player_entry = std::find_if(files.begin(), files.end(), [&](const FileEntry& file) {
            return file.path == player_path;
        });
        if (binary_target != player_path) {
            fs::rename(safe_child(stage, player_path), safe_child(stage, binary_target));
            player_entry->path = binary_target;
        }
        const auto binary_path = safe_child(stage, binary_target);
        verify_linux_dependencies(descriptor, binary_path, libraries);
        *player_entry = track_file(stage, binary_target, "template", "template:" + player_path,
                                   player_entry->mode | 0111);
        fs::permissions(binary_path, static_cast<fs::perms>(player_entry->mode),
                        fs::perm_options::replace);
        const auto config_dir = native_path_from_utf8(binary_target).parent_path().generic_string();
        const auto package_relative =
            config_dir.empty() ? "game.ntpkg" : config_dir + "/game.ntpkg";
        if (names.contains(package_relative) && package_relative != "game.ntpkg")
            return failure("platform-template-collision", "Linux runtime package collides.");
        if (package_relative != "game.ntpkg") {
            fs::create_directories(safe_child(stage, package_relative).parent_path());
            fs::rename(stage / "game.ntpkg", safe_child(stage, package_relative));
        }
        files.push_back(track_file(stage, package_relative, "runtime-package", "game.ntpkg", 0644));
        const auto package_sha = files.back().sha256;
        const auto config_path = config_dir.empty() ? "player.json" : config_dir + "/player.json";
        if (names.contains(config_path))
            return failure("platform-template-collision", "Linux player configuration collides.");

        std::vector<FileEntry> icons;
        if (tools.progress)
            tools.progress("generating-metadata", "Generating Linux icons and desktop metadata");
        for (const unsigned size : {16u, 32u, 48u, 64u, 128u, 256u, 512u}) {
            check_cancellation(tools);
            const auto path = "share/icons/hicolor/" + std::to_string(size) + "x" +
                              std::to_string(size) + "/apps/" + desktop_id + ".png";
            if (names.contains(path))
                return failure("platform-template-collision", "Linux icon path collides.");
            const auto resized =
                tools.resize_image({{"sourcePath", path_text(icon_source)},
                                    {"outputPath", path_text(safe_child(stage, path))},
                                    {"size", size}});
            if (!resized.value("ok", false))
                return failure("platform-icon-generation",
                               resized.value("error", "Linux icon generation failed."));
            icons.push_back(track_file(stage, path, "icon", "hicolor", 0644));
            files.push_back(icons.back());
        }
        const auto escape = [](std::string value) {
            std::string escaped;
            for (const char ch : value) {
                if (ch == '\r')
                    continue;
                if (ch == '\\')
                    escaped += "\\\\";
                else if (ch == '\n')
                    escaped += "\\n";
                else
                    escaped += ch;
            }
            return escaped;
        };
        const auto desktop_path = "share/applications/" + desktop_id + ".desktop";
        write_file(safe_child(stage, desktop_path),
                   "[Desktop Entry]\nType=Application\nVersion=1.0\nName=" + escape(app_name) +
                       "\nExec=" + executable + "\nIcon=" + desktop_id +
                       "\nTerminal=false\nCategories=Game;\nStartupNotify=true\n"
                       "X-NovelTea-ApplicationId=" +
                       escape(app_id) + "\nX-NovelTea-SaveNamespace=" + escape(save_namespace) +
                       "\n");
        files.push_back(
            track_file(stage, desktop_path, "generated-metadata", "linux-desktop-entry", 0644));
        write_file(safe_child(stage, executable),
                   "#!/bin/sh\nset -eu\nROOT=$(CDPATH= cd -- \"$(dirname -- \"$0\")\" && "
                   "pwd)\nexec \"$ROOT/" +
                       binary_target + "\" \"$@\"\n");
        fs::permissions(stage / executable, static_cast<fs::perms>(0755),
                        fs::perm_options::replace);
        files.push_back(
            track_file(stage, executable, "generated-metadata", "linux-launcher", 0755));
        write_file(stage / "LINUX_METADATA.json", Json{{"applicationId", app_id},
                                                       {"saveNamespace", save_namespace},
                                                       {"desktopId", desktop_id},
                                                       {"executable", executable},
                                                       {"player", binary_target},
                                                       {"buildId", descriptor.at("buildId")},
                                                       {"needed", descriptor.at("linuxNeeded")},
                                                       {"rpaths", descriptor.at("linuxRpaths")}}
                                                          .dump(2) +
                                                      '\n');
        files.push_back(
            track_file(stage, "LINUX_METADATA.json", "generated-metadata", "linux-metadata", 0644));

        const auto& memory = profile.at("assetMemory");
        if (memory.value("kind", "") != "builtin")
            return failure("platform-asset-memory-policy",
                           "Native Linux custom asset-memory policies are not yet supported.", 70);
        const std::map<std::string, std::array<std::uint64_t, 7>> baselines{
            {"low", {67108864, 671088640, 33554432, 33554432, 13421772, 536870912, 6710886}},
            {"balanced",
             {134217728, 1342177280, 67108864, 67108864, 40265318, 1073741824, 20132659}},
            {"high",
             {268435456, 2684354560, 134217728, 134217728, 107374182, 2147483648, 53687091}}};
        const auto preset = memory.at("preset").get<std::string>();
        if (!baselines.contains(preset))
            return failure("platform-asset-memory-policy", "Unknown asset-memory preset.");
        const auto& b = baselines.at(preset);
        const Json asset_memory{{"preset", preset},       {"preparedCpuBytes", b[0]},
                                {"gpuBytes", b[1]},       {"audioBytes", b[2]},
                                {"temporaryBytes", b[3]}, {"warmPreparedCpuBytes", b[4]},
                                {"warmGpuBytes", b[5]},   {"warmAudioBytes", b[6]}};
        const auto& raw_display = options.at("display");
        const auto& raw_access = options.at("accessibility");
        const Json display{{"referenceResolution", raw_display.at("reference_resolution")},
                           {"worldRasterPolicy", raw_display.at("world_raster_policy")},
                           {"barColor", raw_display.at("bar_color")}};
        const Json accessibility{{"uiScale", raw_access.at("ui_scale")},
                                 {"textScale", raw_access.at("text_scale")}};
        Json player{{"format", "noveltea.player-config"},
                    {"formatVersion", 1},
                    {"displayName", app_name},
                    {"applicationId", app_id},
                    {"saveNamespace", save_namespace},
                    {"versionName", version},
                    {"package", {{"path", "game.ntpkg"}, {"sha256", package_sha}}},
                    {"capabilities", Json::array({"external-url"})},
                    {"display", display},
                    {"accessibility", accessibility},
                    {"assetMemory", asset_memory}};
        if (app.contains("defaultLocale") && app.at("defaultLocale").is_string())
            player["defaultLocale"] = app.at("defaultLocale");
        write_file(safe_child(stage, config_path), player.dump(2) + '\n');
        files.push_back(
            track_file(stage, config_path, "generated-metadata", "player-config", 0644));
        const auto& resolution = display.at("referenceResolution");
        const auto width = resolution.at("width").get<int>();
        const auto height = resolution.at("height").get<int>();
        if (width <= 0 || height <= 0)
            return failure("platform-runtime-display", "Linux display resolution is invalid.");
        const auto divisor = std::gcd(width, height);
        const Json geometry{
            {"aspectRatio", {{"width", width / divisor}, {"height", height / divisor}}},
            {"orientation", width >= height ? "landscape" : "portrait"},
            {"barColor", display.at("barColor")}};
        const Json deployment{{"target", "linux"},
                              {"architecture", profile.at("architecture")},
                              {"buildFlavor", profile.at("buildFlavor")},
                              {"applicationId", app_id},
                              {"displayName", app_name},
                              {"versionName", version},
                              {"saveNamespace", save_namespace},
                              {"capabilities", Json::array({"external-url"})},
                              {"capabilityMetadata",
                               {{"androidPermissions", Json::array()},
                                {"androidFeatures", Json::array()},
                                {"webRequirements", Json::array()},
                                {"desktopFeatures", Json::array()}}},
                              {"display", geometry},
                              {"packageAccess", profile.at("packageAccess")},
                              {"templateId", descriptor.at("templateId")},
                              {"buildId", descriptor.at("buildId")},
                              {"compiledProjectFormatVersion", 1},
                              {"playerRuntimeApiVersion", 1},
                              {"assetMemory", asset_memory}};
        std::sort(files.begin(), files.end(),
                  [](const FileEntry& a, const FileEntry& b) { return a.path < b.path; });
        Json inventory = Json::array();
        Json archive_entries = Json::array();
        for (const auto& file : files) {
            inventory.push_back(file.json());
            archive_entries.push_back({{"sourcePath", path_text(safe_child(stage, file.path))},
                                       {"archivePath", file.path},
                                       {"size", file.size},
                                       {"mode", file.mode}});
        }
        write_file(stage / "export-manifest.json",
                   Json{{"format", "noveltea.platform-export-manifest"},
                        {"deployment", deployment},
                        {"files", inventory}}
                           .dump(2) +
                       '\n');
        files.push_back(track_file(stage, "export-manifest.json", "generated-metadata",
                                   "export-manifest", 0644));
        archive_entries.push_back({{"sourcePath", path_text(stage / "export-manifest.json")},
                                   {"archivePath", "export-manifest.json"},
                                   {"size", fs::file_size(stage / "export-manifest.json")},
                                   {"mode", 0644}});
        if (tools.progress)
            tools.progress("finalizing", "Building Linux distribution and debug-symbol archives");
        const auto pack = [&](const fs::path& path, std::string_view format, const Json& contents) {
            const auto result =
                tools.create_archive({{"outputPath", path_text(path)},
                                      {"format", format},
                                      {"compression", profile.value("compression", "default")},
                                      {"entries", contents}});
            if (!result.value("ok", false))
                throw std::runtime_error(result.value("error", "Linux archive generation failed."));
        };
        pack(entries[1].stage, archive_format, archive_entries);
        std::optional<std::string> symbols_sha;
        if (with_symbols) {
            if (symbols.empty())
                return failure("platform-template-symbols", "Linux template has no debug symbols.");
            const auto symbol_stage = stage / ".symbols-temporary";
            fs::create_directory(symbol_stage);
            Json symbols_entries = Json::array();
            for (const auto& file : symbols) {
                check_cancellation(tools);
                const auto name = native_path_from_utf8(file.path).filename().string();
                const auto target = symbol_stage / native_path_from_utf8(name);
                copy_verified_file(safe_child(template_directory, file.path), target);
                symbols_entries.push_back({{"sourcePath", path_text(target)},
                                           {"archivePath", name},
                                           {"size", file.size},
                                           {"mode", file.mode}});
            }
            write_file(symbol_stage / "BUILD_ID",
                       descriptor.at("buildId").get<std::string>() + '\n');
            symbols_entries.push_back({{"sourcePath", path_text(symbol_stage / "BUILD_ID")},
                                       {"archivePath", "BUILD_ID"},
                                       {"size", fs::file_size(symbol_stage / "BUILD_ID")},
                                       {"mode", 0644}});
            pack(entries[2].stage, "tar.gz", symbols_entries);
            symbols_sha = digest(read_file(entries[2].stage));
            fs::remove_all(symbol_stage);
        }
        std::optional<std::string> appimage_sha;
        if (appimage) {
#if !defined(__linux__)
            return failure("platform-appimage-host", "AppImage requires a Linux assembly host.");
#else
            if (!tools.run_signing_command)
                return failure("CLI_INTERNAL", "External tool executor is missing.", 70);
            const auto appdir = native_path_from_utf8(path_text(destination) + ".AppDir-" + nonce);
            if (fs::exists(fs::symlink_status(appdir)))
                return failure("platform-output-exists", "Linux AppDir staging path is occupied.");
            struct CleanAppDir {
                fs::path path;
                ~CleanAppDir()
                {
                    std::error_code ignored;
                    fs::remove_all(path, ignored);
                }
            } clean_appdir{appdir};
            fs::create_directory(appdir);
            for (const auto& file : files) {
                const auto target = safe_child(appdir, file.path);
                copy_verified_file(safe_child(stage, file.path), target);
                fs::permissions(target, static_cast<fs::perms>(file.mode & 0777),
                                fs::perm_options::replace);
            }
            write_file(appdir / "AppRun", "#!/bin/sh\nset -eu\nHERE=$(CDPATH= cd -- \"$(dirname -- "
                                          "\"$0\")\" && pwd)\nexec \"$HERE/" +
                                              binary_target + "\" \"$@\"\n");
            fs::permissions(appdir / "AppRun", static_cast<fs::perms>(0755),
                            fs::perm_options::replace);
            copy_verified_file(safe_child(stage, desktop_path),
                               appdir / native_path_from_utf8(desktop_id + ".desktop"));
            copy_verified_file(safe_child(stage, icons.back().path),
                               appdir / native_path_from_utf8(desktop_id + ".png"));
            const char* selected = std::getenv("NOVELTEA_LINUX_APPIMAGE_TOOL");
            const std::string tool = selected && *selected ? selected : "appimagetool";
            if (!tools.run_signing_command("env",
                                           {"ARCH=x86_64", "APPIMAGE_EXTRACT_AND_RUN=1", tool,
                                            path_text(appdir), path_text(entries[3].stage)},
                                           destination.parent_path()))
                return failure("platform-appimage-tool",
                               "AppImage creation requires the configured appimagetool.");
            const auto image_bytes = read_file(entries[3].stage);
            if (image_bytes.size() < 4096 || image_bytes.substr(0, 4) != std::string{"\x7f"
                                                                                     "ELF",
                                                                                     4})
                return failure("platform-appimage-invalid",
                               "AppImage tool did not emit an ELF image.");
            appimage_sha = digest(image_bytes);
#endif
        }
        check_cancellation(tools);
        // The native archive writer emits deterministic tar/ZIP bytes. For tar,
        // independently regenerate from the declared inventory before accepting
        // the exact published archive hash. CI also extracts every tar member.
        if (archive_format == std::string_view{"zip"})
            verify_archive(entries[1].stage, stage, files);
        else {
            const auto comparison = native_path_from_utf8(path_text(entries[1].stage) + ".verify");
            struct CleanArchive {
                fs::path path;
                ~CleanArchive()
                {
                    std::error_code ignored;
                    fs::remove(path, ignored);
                }
            } clean_comparison{comparison};
            pack(comparison, "tar.gz", archive_entries);
            if (digest(read_file(comparison)) != digest(read_file(entries[1].stage)))
                return failure("platform-archive-failed", "Linux tar archive readback disagrees.");
        }
        const auto archive_sha = digest(read_file(entries[1].stage));
        const auto sources_fresh = [&]() {
            if (!source_current() || !tools.physical_sources_current(options) ||
                digest(read_file(icon_source)) != icon_sha ||
                digest(read_file(template_directory / "template.json")) != descriptor_sha ||
                digest(read_file(template_directory / ".noveltea-template.json")) != registry_sha)
                return false;
            for (const auto& item : descriptor.at("files")) {
                const auto original =
                    safe_child(template_directory, item.at("path").get<std::string>());
                if (!fs::is_regular_file(fs::symlink_status(original)) ||
                    digest(read_file(original)) != item.at("sha256").get<std::string>())
                    return false;
            }
            return true;
        };
        if (tools.progress)
            tools.progress("verifying", "Checking Linux source and publication integrity");
        if (!sources_fresh())
            return failure("WORKSPACE_REVISION_CONFLICT", "Linux source changed before publish.",
                           5);
        publish(destination, entries, nonce, [&]() {
            check_cancellation(tools);
            std::set<std::string> found;
            for (fs::recursive_directory_iterator it(destination), end; it != end; ++it) {
                const auto status = it->symlink_status();
                if (fs::is_symlink(status) ||
                    (!fs::is_regular_file(status) && !fs::is_directory(status)))
                    throw std::runtime_error("Unsafe Linux distribution member.");
                if (fs::is_regular_file(status))
                    found.insert(it->path().lexically_relative(destination).generic_string());
            }
            std::set<std::string> expected;
            for (const auto& file : files) {
                expected.insert(file.path);
                if (digest(read_file(safe_child(destination, file.path))) != file.sha256)
                    throw std::runtime_error("Published Linux file changed: " + file.path);
            }
            if (found != expected || digest(read_file(archive_path)) != archive_sha ||
                (symbols_sha && digest(read_file(symbols_path)) != *symbols_sha) ||
                (appimage_sha && digest(read_file(appimage_path)) != *appimage_sha))
                throw std::runtime_error("Published Linux artifact inventory changed.");
            check_cancellation(tools);
            if (!sources_fresh())
                throw SourceChanged("Linux inputs changed during publication.");
        });
        Json artifacts = Json::array({{{"kind", "directory"}, {"path", path_text(destination)}},
                                      {{"kind", "archive"},
                                       {"path", path_text(archive_path)},
                                       {"size", fs::file_size(archive_path)}}});
        Json result{{"success", true},
                    {"exitCode", 0},
                    {"diagnostics", Json::array()},
                    {"outputDirectory", path_text(destination)},
                    {"archivePath", path_text(archive_path)},
                    {"templateToken", descriptor.at("templateId").get<std::string>() + "@" +
                                          descriptor.at("buildId").get<std::string>()},
                    {"signingRequested", false},
                    {"signingApplied", false},
                    {"cancelled", false},
                    {"deployment", deployment}};
        if (with_symbols) {
            result["symbolArchivePath"] = path_text(symbols_path);
            artifacts.push_back({{"kind", "symbols"},
                                 {"path", path_text(symbols_path)},
                                 {"size", fs::file_size(symbols_path)}});
        }
        if (appimage) {
            artifacts.push_back({{"kind", "appimage"},
                                 {"path", path_text(appimage_path)},
                                 {"size", fs::file_size(appimage_path)}});
        }
        result["artifacts"] = std::move(artifacts);
        return {std::move(result), "Native Linux platform export succeeded."};
    } catch (const ExportCancelled& error) {
        auto cancelled = failure("export-cancelled", error.what(), 130);
        cancelled.envelope["cancelled"] = true;
        return cancelled;
    } catch (const SourceChanged& error) {
        return failure("WORKSPACE_REVISION_CONFLICT", error.what(), 5);
    } catch (const std::exception& error) {
        return failure("platform-staging-failed", error.what());
    }
}

std::string mac_xml_escape(std::string_view value)
{
    std::string escaped;
    for (const char ch : value) {
        switch (ch) {
        case '&':
            escaped += "&amp;";
            break;
        case '<':
            escaped += "&lt;";
            break;
        case '>':
            escaped += "&gt;";
            break;
        case '"':
            escaped += "&quot;";
            break;
        case '\'':
            escaped += "&apos;";
            break;
        default:
            escaped += ch;
        }
    }
    return escaped;
}

void mac_put_be32(std::string& output, std::uint32_t value)
{
    for (int shift = 24; shift >= 0; shift -= 8)
        output.push_back(static_cast<char>((value >> shift) & 255u));
}

std::string mac_icns(const fs::path& icon_source, const fs::path& stage,
                     const PlatformExportTools& tools)
{
    std::string result = "icns";
    mac_put_be32(result, 0);
    const std::array<std::pair<unsigned, std::string_view>, 6> sizes{
        {{16, "icp4"}, {32, "icp5"}, {128, "ic07"}, {256, "ic08"}, {512, "ic09"}, {1024, "ic10"}}};
    for (const auto& [size, kind] : sizes) {
        check_cancellation(tools);
        const auto scratch = stage / (".mac-icon-" + std::to_string(size) + ".png");
        const auto resized = tools.resize_image({{"sourcePath", path_text(icon_source)},
                                                 {"outputPath", path_text(scratch)},
                                                 {"size", size}});
        if (!resized.value("ok", false))
            throw std::runtime_error("macOS icon generation failed.");
        const auto png = read_file(scratch);
        fs::remove(scratch);
        if (!png.starts_with("\x89PNG\r\n\x1a\n"))
            throw std::runtime_error("macOS icon encoder returned invalid PNG bytes.");
        result += kind;
        mac_put_be32(result, static_cast<std::uint32_t>(png.size() + 8));
        result += png;
    }
    const auto length = static_cast<std::uint32_t>(result.size());
    for (unsigned i = 0; i < 4; ++i)
        result[4 + i] = static_cast<char>((length >> (24 - i * 8)) & 255u);
    return result;
}

PlatformCliResult stage_macos_export(const Json& admission, const Json& profile,
                                     const Json& descriptor, const fs::path& template_directory,
                                     const fs::path& icon_source, const fs::path& destination,
                                     bool force, bool allow_localization_warnings,
                                     bool include_unused_assets, bool include_shader_sources,
                                     const PlatformResolvedExportSettings& settings,
                                     const PlatformExportTools& tools,
                                     const std::function<bool()>& source_current)
{
    if (!tools.prepare_package || !tools.create_archive || !tools.resize_image ||
        !tools.physical_sources_current)
        return failure("CLI_INTERNAL", "Native macOS export tools are unavailable.", 70);
    try {
        if (destination.extension() != ".app")
            return failure("platform-output-invalid", "macOS destination must end in .app.");
        if (profile.value("packageAccess", "") != "bundle-resource" ||
            profile.at("desktop").value("artifact", "") != "app-bundle")
            return failure("platform-artifact-invalid", "macOS requires an app-bundle profile.");
        if (!descriptor.contains("macosMachO") || !descriptor.at("macosMachO").is_array() ||
            !descriptor.contains("macosDependencies") || !descriptor.contains("macosRpaths"))
            return failure("platform-template-macho", "macOS template has no Mach-O inventory.");
        const auto& app = admission.at("project").at("settings").at("app");
        const auto executable = profile.at("desktop").at("executableName").get<std::string>();
        if (executable.empty() || executable == "." || executable == ".." ||
            !std::all_of(executable.begin(), executable.end(), [](unsigned char c) {
                return std::isalnum(c) || c == '.' || c == '_' || c == '+' || c == '-';
            }))
            return failure("platform-executable-name-invalid", "Invalid macOS executable name.");
        const auto app_id = app.at("applicationId").get<std::string>();
        if (app_id.find('.') == std::string::npos || app_id.front() == '.' ||
            app_id.back() == '.' || app_id.find("..") != std::string::npos ||
            !std::all_of(app_id.begin(), app_id.end(),
                         [](unsigned char c) { return std::isalnum(c) || c == '.' || c == '-'; }))
            return failure("platform-bundle-id-invalid", "Invalid macOS bundle identifier.");
        const auto name = app.at("displayName").get<std::string>();
        const auto version = app.at("versionName").get<std::string>();
        const auto save_namespace = app.at("saveNamespace").get<std::string>();
        const auto descriptor_sha = digest(read_file(template_directory / "template.json"));
        const auto registry_sha = digest(read_file(template_directory / ".noveltea-template.json"));
        const auto icon_sha = digest(read_file(icon_source));
        if (Json::parse(read_file(template_directory / "template.json")) != descriptor)
            return failure("platform-template-changed", "macOS template changed after preflight.",
                           5);
#if !defined(__APPLE__)
        if (settings.signing_requested || settings.dmg_requested)
            return failure("platform-macos-host-required",
                           "macOS signing, notarization, and DMG creation require a macOS host.");
#endif
        const bool symbols_requested = profile.value("includeDebugSymbols", false);
        const auto base = path_text(destination).substr(0, path_text(destination).size() - 4);
        const std::array<fs::path, 6> outputs{
            destination,
            native_path_from_utf8(base + ".zip"),
            native_path_from_utf8(base + "-symbols.zip"),
            native_path_from_utf8(base + ".dmg"),
            native_path_from_utf8(base + "-signing-report.json"),
            native_path_from_utf8(base + "-export-manifest.json")};
        const auto nonce = random_nonce();
        std::vector<PublicationEntry> entries;
        for (std::size_t i = 0; i < outputs.size(); ++i) {
            const auto& output = outputs[i];
            const bool retire = (i == 2 && !symbols_requested) ||
                                (i == 3 && !settings.dmg_requested) ||
                                (i == 4 && !settings.signing_requested);
            entries.push_back({output, native_path_from_utf8(path_text(output) + ".stage-" + nonce),
                               native_path_from_utf8(path_text(output) + ".previous-" + nonce),
                               fs::exists(fs::symlink_status(output)), retire});
            if (fs::is_symlink(fs::symlink_status(output)) ||
                fs::exists(fs::symlink_status(entries.back().stage)) ||
                fs::exists(fs::symlink_status(entries.back().previous)) ||
                (entries.back().had_previous && !force))
                return failure("platform-output-exists", "macOS output is occupied or unsafe.");
        }
        fs::create_directories(destination.parent_path());
        Staging cleanup(entries, journal_path(destination));
        fs::create_directory(entries.front().stage);
        // macOS tools recognize the inner .app suffix, not the publisher's
        // transaction suffix. Move into the journal-owned path only at commit.
        const auto stage = entries.front().stage / destination.filename();
        fs::create_directory(stage);
        Json native_profile = admission.at("profile");
        native_profile["shaderVariants"] = Json::array({"metal"});
        native_profile["localization"] = profile.at("localization");
        native_profile["excludeUnusedAssets"] =
            include_unused_assets ? false : profile.value("excludeUnusedAssets", true);
        native_profile["includeShaderSources"] =
            include_shader_sources || profile.value("includeShaderSources", false);
        native_profile["stripShaderSources"] =
            !native_profile.at("includeShaderSources").get<bool>();
        if (!source_current())
            return failure("WORKSPACE_REVISION_CONFLICT", "macOS sources changed.", 5);
        if (tools.progress)
            tools.progress("writing-package", "Preparing macOS runtime package");
        const std::string package_name = "Contents/Resources/game.ntpkg";
        fs::create_directories((stage / package_name).parent_path());
        const auto packaged =
            tools.prepare_package(admission, native_profile, stage / package_name);
        check_cancellation(tools);
        if (!packaged.value("ok", false))
            return failure(packaged.value("code", "native.platform.package"),
                           packaged.value("error", "macOS runtime package failed."), 6);
        const auto& artifact = packaged.at("artifact");
        if (!artifact.contains("compiledProject") ||
            artifact.at("packageOptions").value("kind", "") != "runtime")
            return failure("native.runtime.artifact", "Invalid macOS package evidence.", 6);
        const auto& options = artifact.at("packageOptions");
        for (const auto& diagnostic : artifact.value("diagnostics", Json::array()))
            if (diagnostic.value("severity", "") == "warning" &&
                diagnostic.value("code", std::string{}).starts_with("localization.export.") &&
                !allow_localization_warnings)
                return failure("localization.export.warning_override_required",
                               "Localization warnings require --allow-localization-warnings.");
        const auto package_sha = digest(read_file(stage / package_name));
        std::vector<FileEntry> files, symbols;
        files.push_back(track_file(stage, package_name, "runtime-package", "game.ntpkg", 0644));
        std::map<std::string, std::string> relocation;
        std::map<std::string, std::string> library_names;
        std::set<std::string> occupied{package_name};
        bool found_player = false;
        for (const auto& item : descriptor.at("files")) {
            check_cancellation(tools);
            const auto original = item.at("path").get<std::string>();
            const auto mode = item.at("mode").get<std::uint32_t>();
            const auto role = item.value("role", "");
            const auto source = safe_child(template_directory, original);
            if (!fs::is_regular_file(fs::symlink_status(source)) ||
                fs::file_size(source) != item.at("size").get<std::uint64_t>() ||
                digest(read_file(source)) != item.at("sha256").get<std::string>())
                return failure("invalid-installed-template", "macOS template file changed.", 5);
            if (role == "symbol" || original.starts_with("symbols/")) {
                symbols.push_back({original, "symbol", original, mode,
                                   item.at("size").get<std::uint64_t>(),
                                   item.at("sha256").get<std::string>()});
                continue;
            }
            std::string target;
            if (role == "player") {
                if (found_player || !(mode & 0111))
                    return failure("platform-template-player", "Invalid macOS player declaration.");
                found_player = true;
                target = "Contents/MacOS/" + executable;
            } else if (role == "native-dependency") {
                const auto framework = original.find(".framework/");
                target =
                    framework == std::string::npos
                        ? "Contents/Frameworks/" +
                              native_path_from_utf8(original).filename().string()
                        : "Contents/Frameworks/" +
                              original.substr(original.rfind('/', framework) == std::string::npos
                                                  ? 0
                                                  : original.rfind('/', framework) + 1);
                if (!library_names
                         .emplace(native_path_from_utf8(original).filename().string(), target)
                         .second)
                    return failure("platform-template-dependencies",
                                   "Ambiguous macOS framework library name.");
            } else {
                target = "Contents/Resources/" + original;
            }
            if (!occupied.insert(target).second)
                return failure("platform-template-collision",
                               "macOS bundle contains colliding template paths.");
            relocation.emplace(original, target);
            const auto destination_path = safe_child(stage, target);
            copy_verified_file(source, destination_path);
            fs::permissions(destination_path, static_cast<fs::perms>(mode & 0777),
                            fs::perm_options::replace);
            files.push_back(track_file(stage, target,
                                       role == "native-dependency" ? "native-dependency"
                                       : role == "notice"          ? "notice"
                                                                   : "template",
                                       "template:" + original, mode));
            if (original.starts_with("licenses/")) {
                const auto mounted = "Contents/Resources/assets/system/" + original;
                if (!occupied.insert(mounted).second)
                    return failure("platform-template-collision", "macOS license path collision.");
                copy_verified_file(destination_path, safe_child(stage, mounted));
                files.push_back(track_file(stage, mounted, "system-asset", original, mode));
            }
        }
        if (!found_player)
            return failure("platform-template-player", "macOS template has no executable.");
        std::set<std::string> declared_macho;
        for (const auto& item : descriptor.at("macosMachO")) {
            const auto original = item.at("path").get<std::string>();
            if (!relocation.contains(original) || !declared_macho.insert(original).second)
                return failure("platform-template-macho", "Invalid macOS Mach-O inventory.");
            const auto actual =
                inspect_macho_arm64(read_file(safe_child(stage, relocation.at(original))));
            std::set<std::string> declared_deps(item.at("dependencies").begin(),
                                                item.at("dependencies").end());
            const std::set<std::string> declared_rpaths(item.at("rpaths").begin(),
                                                        item.at("rpaths").end());
            auto declared_uuid = item.value("uuid", "");
            std::transform(declared_uuid.begin(), declared_uuid.end(), declared_uuid.begin(),
                           [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
            // The release template uses otool -L: for dylibs its first row
            // reports LC_ID_DYLIB, not an LC_LOAD_* dependency.
            if (!actual.install_name.empty())
                declared_deps.erase(actual.install_name);
            if (actual.dependencies != declared_deps || actual.rpaths != declared_rpaths ||
                (!declared_uuid.empty() && actual.uuid != declared_uuid))
                return failure("platform-template-macho",
                               "Mach-O bytes differ from the certified dependency/UUID inventory.");
            if (item.value("role", "") == "native-dependency" &&
                actual.install_name !=
                    "@rpath/" + fs::path(relocation.at(original)).filename().string())
                return failure("platform-template-install-name",
                               "Nonportable Mach-O install name.");
            for (const auto& rpath : actual.rpaths)
                if (!rpath.starts_with("@executable_path/") &&
                    !rpath.starts_with("@loader_path/") && !rpath.starts_with("@rpath/"))
                    return failure("platform-template-rpath", "Nonportable Mach-O runtime path.");
            for (const auto& dependency : actual.dependencies) {
                if (dependency.starts_with("/usr/lib/") ||
                    dependency.starts_with("/System/Library/"))
                    continue;
                const auto basename = fs::path(dependency).filename().string();
                if (!(dependency == "@rpath/" + basename ||
                      dependency == "@loader_path/" + basename) ||
                    !library_names.contains(basename))
                    return failure("platform-template-dependencies",
                                   "Unresolved or nonportable Mach-O dependency: " + dependency);
            }
        }
        for (const auto& item : descriptor.at("files"))
            if ((item.value("role", "") == "player" ||
                 item.value("role", "") == "native-dependency") &&
                !declared_macho.contains(item.at("path").get<std::string>()))
                return failure("platform-template-macho", "Undeclared macOS native binary.");
        const std::set<std::string> global_deps(descriptor.at("macosDependencies").begin(),
                                                descriptor.at("macosDependencies").end());
        const std::set<std::string> global_rpaths(descriptor.at("macosRpaths").begin(),
                                                  descriptor.at("macosRpaths").end());
        const auto player_original =
            std::find_if(descriptor.at("files").begin(), descriptor.at("files").end(),
                         [](const Json& file) { return file.value("role", "") == "player"; });
        if (player_original == descriptor.at("files").end())
            return failure("platform-template-player", "macOS player declaration is missing.");
        const auto player_macho = inspect_macho_arm64(read_file(
            safe_child(stage, relocation.at(player_original->at("path").get<std::string>()))));
        if (player_macho.dependencies != global_deps || player_macho.rpaths != global_rpaths)
            return failure("platform-template-macho", "macOS player dependency inventory differs.");
        const auto player_path = "Contents/MacOS/" + executable;
        if (!library_names.empty() &&
            !player_macho.rpaths.contains("@executable_path/../Frameworks"))
            return failure("platform-template-rpath",
                           "Player is missing the portable Frameworks search path.");
        const auto locale = app.value("defaultLocale", "en");
        const auto mac_info = app.value("desktop", Json::object());
        const auto category = mac_info.value("macosCategory", "public.app-category.games");
        const auto microphone = mac_info.value("macosMicrophoneUsageDescription", "");
        const bool has_microphone =
            std::find(descriptor.at("capabilities").begin(), descriptor.at("capabilities").end(),
                      "microphone") != descriptor.at("capabilities").end();
        if (has_microphone && microphone.empty())
            return failure("platform-macos-privacy",
                           "Microphone-enabled macOS template needs a usage description.");
        const auto plist =
            std::string{"<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n"
                        "<plist version=\"1.0\"><dict>\n"
                        "<key>CFBundleDevelopmentRegion</key><string>"} +
            mac_xml_escape(locale) + "</string>\n<key>CFBundleDisplayName</key><string>" +
            mac_xml_escape(name) + "</string>\n<key>CFBundleExecutable</key><string>" +
            mac_xml_escape(executable) +
            "</string>\n<key>CFBundleIconFile</key><string>AppIcon</string>\n"
            "<key>CFBundleIdentifier</key><string>" +
            mac_xml_escape(app_id) +
            "</string>\n<key>CFBundleInfoDictionaryVersion</key><string>6.0</string>\n"
            "<key>CFBundleName</key><string>" +
            mac_xml_escape(name) +
            "</string>\n<key>CFBundlePackageType</key><string>APPL</string>\n"
            "<key>CFBundleShortVersionString</key><string>" +
            mac_xml_escape(version) + "</string>\n<key>CFBundleVersion</key><string>" +
            mac_xml_escape(version) + "</string>\n<key>LSApplicationCategoryType</key><string>" +
            mac_xml_escape(category) +
            "</string>\n<key>LSMinimumSystemVersion</key><string>11.0</string>\n"
            "<key>NSHighResolutionCapable</key><true/>\n" +
            (has_microphone ? "<key>NSMicrophoneUsageDescription</key><string>" +
                                  mac_xml_escape(microphone) + "</string>\n"
                            : "") +
            "</dict></plist>\n";
        const auto generated = [&](const std::string& path, std::string_view bytes,
                                   const std::string& purpose) {
            if (!occupied.insert(path).second)
                throw std::runtime_error("macOS generated resource collides with template.");
            write_file(safe_child(stage, path), bytes);
            files.push_back(track_file(stage, path, "generated-metadata", purpose, 0644));
        };
        generated("Contents/Info.plist", plist, "macos-info-plist");
        auto localized_name = name;
        std::string escaped_name;
        for (char c : localized_name) {
            if (c == '"' || c == '\\')
                escaped_name += '\\';
            if (c == '\r' || c == '\n')
                return failure("platform-bundle-id-invalid",
                               "macOS localized display name contains a line break.");
            escaped_name += c;
        }
        generated("Contents/Resources/" + locale + ".lproj/InfoPlist.strings",
                  "CFBundleDisplayName = \"" + escaped_name + "\";\n", "macos-localized-info");
        if (!occupied.insert("Contents/Resources/AppIcon.icns").second)
            return failure("platform-template-collision", "macOS icon collision.");
        write_file(stage / "Contents/Resources/AppIcon.icns", mac_icns(icon_source, stage, tools));
        files.push_back(
            track_file(stage, "Contents/Resources/AppIcon.icns", "icon", "macos-icns", 0644));
        const auto& memory = profile.at("assetMemory");
        if (memory.value("kind", "") != "builtin")
            return failure("platform-asset-memory-policy",
                           "Native macOS custom asset-memory policies are unavailable.", 70);
        const auto preset = memory.at("preset").get<std::string>();
        const std::map<std::string, std::array<std::uint64_t, 7>> baselines{
            {"low", {67108864, 671088640, 33554432, 33554432, 13421772, 536870912, 6710886}},
            {"balanced",
             {134217728, 1342177280, 67108864, 67108864, 40265318, 1073741824, 20132659}},
            {"high",
             {268435456, 2684354560, 134217728, 134217728, 107374182, 2147483648, 53687091}}};
        if (!baselines.contains(preset))
            return failure("platform-asset-memory-policy", "Unknown asset-memory preset.");
        const auto& b = baselines.at(preset);
        const Json asset_memory{{"preset", preset},       {"preparedCpuBytes", b[0]},
                                {"gpuBytes", b[1]},       {"audioBytes", b[2]},
                                {"temporaryBytes", b[3]}, {"warmPreparedCpuBytes", b[4]},
                                {"warmGpuBytes", b[5]},   {"warmAudioBytes", b[6]}};
        const auto& raw_display = options.at("display");
        const auto& raw_access = options.at("accessibility");
        const Json display{{"referenceResolution", raw_display.at("reference_resolution")},
                           {"worldRasterPolicy", raw_display.at("world_raster_policy")},
                           {"barColor", raw_display.at("bar_color")}};
        const Json accessibility{{"uiScale", raw_access.at("ui_scale")},
                                 {"textScale", raw_access.at("text_scale")}};
        Json player{{"format", "noveltea.player-config"},
                    {"formatVersion", 1},
                    {"displayName", name},
                    {"applicationId", app_id},
                    {"saveNamespace", save_namespace},
                    {"versionName", version},
                    {"package", {{"path", "game.ntpkg"}, {"sha256", package_sha}}},
                    {"capabilities", Json::array({"external-url"})},
                    {"display", display},
                    {"accessibility", accessibility},
                    {"assetMemory", asset_memory},
                    {"defaultLocale", locale}};
        generated("Contents/Resources/player.json", player.dump(2) + '\n', "player-config");
        const auto& resolution = display.at("referenceResolution");
        const auto width = resolution.at("width").get<int>();
        const auto height = resolution.at("height").get<int>();
        if (width <= 0 || height <= 0)
            return failure("platform-runtime-display", "Invalid macOS reference resolution.");
        const auto divisor = std::gcd(width, height);
        const Json deployment{
            {"target", "macos"},
            {"architecture", profile.at("architecture")},
            {"buildFlavor", profile.at("buildFlavor")},
            {"applicationId", app_id},
            {"displayName", name},
            {"versionName", version},
            {"saveNamespace", save_namespace},
            {"capabilities", Json::array({"external-url"})},
            {"capabilityMetadata",
             {{"androidPermissions", Json::array()},
              {"androidFeatures", Json::array()},
              {"webRequirements", Json::array()},
              {"desktopFeatures", Json::array()}}},
            {"display",
             {{"aspectRatio", {{"width", width / divisor}, {"height", height / divisor}}},
              {"orientation", width >= height ? "landscape" : "portrait"},
              {"barColor", display.at("barColor")}}},
            {"packageAccess", profile.at("packageAccess")},
            {"templateId", descriptor.at("templateId")},
            {"buildId", descriptor.at("buildId")},
            {"compiledProjectFormatVersion", 1},
            {"playerRuntimeApiVersion", 1},
            {"assetMemory", asset_memory}};
        // Sign nested binaries first, then seal the complete bundle. Never
        // write a resource after codesign: even a manifest would break the seal.
        bool notarized = false;
        if (settings.signing_requested) {
#if !defined(__APPLE__)
            return failure("platform-macos-host-required", "macOS signing requires macOS.");
#else
            const auto& signer = settings.signing.at("macos");
            const auto identity = signer.at("identity").get<std::string>();
            if (!tools.run_signing_command)
                return failure("CLI_INTERNAL", "macOS signing executor is missing.", 70);
            std::vector<std::string> frameworks;
            for (const auto& [original, target] : relocation)
                if (target.starts_with("Contents/Frameworks/"))
                    frameworks.push_back(target);
            std::sort(frameworks.begin(), frameworks.end());
            for (const auto& framework : frameworks) {
                check_cancellation(tools);
                std::vector<std::string> args{"--force", "--options", "runtime", "--sign",
                                              identity};
                if (identity != "-")
                    args.insert(args.begin() + 1, "--timestamp");
                args.push_back(path_text(stage / framework));
                if (!tools.run_signing_command("codesign", args, stage))
                    return failure("platform.signing_failed", "macOS framework signing failed.");
            }
            std::vector<std::string> sign_args{"--force", "--options", "runtime", "--sign",
                                               identity};
            if (identity != "-")
                sign_args.insert(sign_args.begin() + 1, "--timestamp");
            if (signer.contains("entitlementsPath") &&
                !signer.at("entitlementsPath").get<std::string>().empty()) {
                const auto path =
                    native_path_from_utf8(signer.at("entitlementsPath").get<std::string>());
                if (!fs::is_regular_file(path))
                    return failure("platform.signing_configuration_invalid",
                                   "macOS entitlements file is missing.");
                sign_args.insert(sign_args.end(), {"--entitlements", path_text(path)});
            }
            sign_args.push_back(path_text(stage));
            if (!tools.run_signing_command("codesign", sign_args, stage))
                return failure("platform.signing_failed", "macOS bundle signing failed.");
            if (!tools.run_signing_command(
                    "codesign", {"--verify", "--deep", "--strict", path_text(stage)}, stage))
                return failure("platform.signature_verification_failed",
                               "macOS bundle signature verification failed.");
            if (signer.contains("notarizationCommand") &&
                !signer.at("notarizationCommand").get<std::string>().empty()) {
                const auto notary_zip =
                    native_path_from_utf8(path_text(entries[1].stage) + ".notary.zip");
                struct RemoveNotary {
                    fs::path path;
                    ~RemoveNotary()
                    {
                        std::error_code ignored;
                        fs::remove(path, ignored);
                    }
                } remove_notary{notary_zip};
                Json zip_entries = Json::array();
                for (fs::recursive_directory_iterator it(stage), end; it != end; ++it)
                    if (it->is_regular_file())
                        zip_entries.push_back(
                            {{"sourcePath", path_text(it->path())},
                             {"archivePath",
                              destination.filename().string() + "/" +
                                  it->path().lexically_relative(stage).generic_string()},
                             {"size", fs::file_size(it->path())},
                             {"mode", 0644}});
                const auto preflight = tools.create_archive({{"outputPath", path_text(notary_zip)},
                                                             {"format", "zip"},
                                                             {"compression", "default"},
                                                             {"entries", zip_entries}});
                if (!preflight.value("ok", false))
                    return failure("platform-archive-failed",
                                   "Cannot prepare notarization upload.");
                std::vector<std::string> args;
                for (const auto& arg : signer.value("notarizationArgs", Json::array()))
                    args.push_back(arg.get<std::string>());
                args.push_back(path_text(notary_zip));
                if (!tools.run_signing_command(signer.at("notarizationCommand").get<std::string>(),
                                               args, stage) ||
                    !tools.run_signing_command("xcrun", {"stapler", "staple", path_text(stage)},
                                               stage) ||
                    !tools.run_signing_command("xcrun", {"stapler", "validate", path_text(stage)},
                                               stage))
                    return failure("platform.notarization_failed",
                                   "macOS notarization or ticket stapling failed.");
                notarized = true;
            }
#endif
        }
        // Inventory signed bytes (including Apple's _CodeSignature) after
        // signing and stapling. The export manifest is a sidecar by design.
        std::map<std::string, std::pair<std::string, std::string>> provenance;
        for (const auto& file : files)
            provenance.emplace(file.path, std::make_pair(file.origin, file.origin_id));
        files.clear();
        for (fs::recursive_directory_iterator it(stage), end; it != end; ++it) {
            const auto status = it->symlink_status();
            if (fs::is_symlink(status) ||
                (!fs::is_regular_file(status) && !fs::is_directory(status)))
                return failure("platform-bundle-invalid", "Unsafe macOS bundle member.");
            if (!fs::is_regular_file(status))
                continue;
            const auto relative = it->path().lexically_relative(stage).generic_string();
            const auto mode = static_cast<std::uint32_t>(status.permissions()) & 0777u;
            const auto former = provenance.find(relative);
            files.push_back(track_file(
                stage, relative, former != provenance.end() ? former->second.first : "signature",
                former != provenance.end() ? former->second.second : "macos-codesign", mode));
        }
        if (settings.signing_requested) {
            const auto& signer = settings.signing.at("macos");
            const auto report =
                Json{{"format", "noveltea.signing-report"},
                     {"platform", "macos"},
                     {"templateBuildId", descriptor.at("buildId")},
                     {"gamePackageSha256", package_sha},
                     {"identitySha256", digest(signer.at("identity").get<std::string>())},
                     {"signed", true},
                     {"verified", true},
                     {"hardenedRuntime", true},
                     {"notarized", notarized},
                     {"stapled", notarized}};
            write_file(entries[4].stage, report.dump(2) + '\n');
        }
        Json inventory = Json::array();
        Json zip_entries = Json::array();
        std::sort(files.begin(), files.end(),
                  [](const FileEntry& a, const FileEntry& b) { return a.path < b.path; });
        for (const auto& file : files) {
            inventory.push_back(file.json());
            zip_entries.push_back(
                {{"sourcePath", path_text(stage / file.path)},
                 {"archivePath", destination.filename().string() + "/" + file.path},
                 {"size", file.size},
                 {"mode", file.mode}});
        }
        write_file(entries[5].stage, Json{{"format", "noveltea.platform-export-manifest"},
                                          {"deployment", deployment},
                                          {"files", inventory}}
                                             .dump(2) +
                                         '\n');
        const auto archive =
            tools.create_archive({{"outputPath", path_text(entries[1].stage)},
                                  {"format", "zip"},
                                  {"compression", profile.value("compression", "default")},
                                  {"entries", zip_entries}});
        check_cancellation(tools);
        if (!archive.value("ok", false))
            return failure("platform-archive-failed", "macOS bundle ZIP failed.");
        verify_archive(entries[1].stage, stage, files, destination.filename().string() + "/");
        if (symbols_requested) {
            if (symbols.empty())
                return failure("platform-template-symbols", "macOS template lacks debug symbols.");
            const auto symbol_stage = stage.parent_path() / (".mac-symbols-" + nonce);
            struct RemoveSymbols {
                fs::path path;
                ~RemoveSymbols()
                {
                    std::error_code ignored;
                    fs::remove_all(path, ignored);
                }
            } remove_symbols{symbol_stage};
            fs::create_directory(symbol_stage);
            Json symbol_entries = Json::array();
            for (const auto& item : symbols) {
                const auto path = item.path.substr(std::string("symbols/").size());
                const auto copy = safe_child(symbol_stage, path);
                copy_verified_file(safe_child(template_directory, item.path), copy);
                symbol_entries.push_back({{"sourcePath", path_text(copy)},
                                          {"archivePath", path},
                                          {"size", item.size},
                                          {"mode", item.mode}});
            }
            write_file(symbol_stage / "BUILD_ID",
                       descriptor.at("buildId").get<std::string>() + '\n');
            symbol_entries.push_back({{"sourcePath", path_text(symbol_stage / "BUILD_ID")},
                                      {"archivePath", "BUILD_ID"},
                                      {"size", fs::file_size(symbol_stage / "BUILD_ID")},
                                      {"mode", 0644}});
            const auto result =
                tools.create_archive({{"outputPath", path_text(entries[2].stage)},
                                      {"format", "zip"},
                                      {"compression", profile.value("compression", "default")},
                                      {"entries", symbol_entries}});
            if (!result.value("ok", false))
                return failure("platform-archive-failed", "macOS symbols archive failed.");
        }
        if (settings.dmg_requested) {
#if !defined(__APPLE__)
            return failure("platform-macos-host-required", "DMG creation requires macOS.");
#else
            const auto dmg_temp = native_path_from_utf8(path_text(entries[3].stage) + ".dmg");
            struct RemoveDmg {
                fs::path path;
                ~RemoveDmg()
                {
                    std::error_code ignored;
                    fs::remove(path, ignored);
                }
            } remove_dmg{dmg_temp};
            if (!tools.run_signing_command ||
                !tools.run_signing_command("hdiutil",
                                           {"create", "-ov", "-format", "UDZO", "-volname", name,
                                            "-srcfolder", path_text(entries[0].stage),
                                            path_text(dmg_temp)},
                                           destination.parent_path()))
                return failure("platform-dmg-tool", "macOS hdiutil DMG creation failed.");
            if (read_file(dmg_temp).size() < 512)
                return failure("platform-dmg-tool", "macOS DMG output is incomplete.");
            fs::rename(dmg_temp, entries[3].stage);
#endif
        }
        const auto archive_sha = digest(read_file(entries[1].stage));
        const auto manifest_sha = digest(read_file(entries[5].stage));
        const auto symbols_sha =
            symbols_requested ? std::optional<std::string>{digest(read_file(entries[2].stage))}
                              : std::nullopt;
        const auto dmg_sha = settings.dmg_requested
                                 ? std::optional<std::string>{digest(read_file(entries[3].stage))}
                                 : std::nullopt;
        const auto report_sha =
            settings.signing_requested
                ? std::optional<std::string>{digest(read_file(entries[4].stage))}
                : std::nullopt;
        const auto sources_fresh = [&]() {
            if (!source_current() || !tools.physical_sources_current(options) ||
                digest(read_file(icon_source)) != icon_sha ||
                digest(read_file(template_directory / "template.json")) != descriptor_sha ||
                digest(read_file(template_directory / ".noveltea-template.json")) != registry_sha)
                return false;
            for (const auto& item : descriptor.at("files"))
                if (digest(read_file(
                        safe_child(template_directory, item.at("path").get<std::string>()))) !=
                    item.at("sha256").get<std::string>())
                    return false;
            return true;
        };
        if (!sources_fresh())
            return failure("WORKSPACE_REVISION_CONFLICT",
                           "macOS inputs changed before publication.", 5);
        // Convert the ordinary .app working directory into the journal-owned
        // stage name only after codesign/stapler/hdiutil have finished.
        const auto intermediate =
            native_path_from_utf8(path_text(entries[0].stage) + ".bundle-" + nonce);
        struct RemoveIntermediate {
            fs::path path;
            ~RemoveIntermediate()
            {
                std::error_code ignored;
                fs::remove_all(path, ignored);
            }
        } remove_intermediate{intermediate};
        fs::rename(stage, intermediate);
        fs::remove(entries[0].stage);
        fs::rename(intermediate, entries[0].stage);
        publish(destination, entries, nonce, [&]() {
            check_cancellation(tools);
            std::set<std::string> found;
            for (fs::recursive_directory_iterator it(destination), end; it != end; ++it) {
                const auto status = it->symlink_status();
                if (fs::is_symlink(status) ||
                    (!fs::is_regular_file(status) && !fs::is_directory(status)))
                    throw std::runtime_error("Unsafe published macOS bundle member.");
                if (fs::is_regular_file(status))
                    found.insert(it->path().lexically_relative(destination).generic_string());
            }
            std::set<std::string> expected;
            for (const auto& file : files) {
                expected.insert(file.path);
                if (digest(read_file(safe_child(destination, file.path))) != file.sha256)
                    throw std::runtime_error("Published macOS bundle bytes changed.");
            }
            if (found != expected || digest(read_file(entries[1].final)) != archive_sha ||
                digest(read_file(entries[5].final)) != manifest_sha ||
                (symbols_sha && digest(read_file(entries[2].final)) != *symbols_sha) ||
                (dmg_sha && digest(read_file(entries[3].final)) != *dmg_sha) ||
                (report_sha && digest(read_file(entries[4].final)) != *report_sha))
                throw std::runtime_error("Published macOS artifact inventory changed.");
            verify_archive(entries[1].final, destination, files,
                           destination.filename().string() + "/");
            if (!sources_fresh())
                throw SourceChanged("macOS inputs changed during publication.");
        });
        Json artifacts = Json::array({{{"kind", "app-bundle"}, {"path", path_text(destination)}},
                                      {{"kind", "archive"},
                                       {"path", path_text(outputs[1])},
                                       {"size", fs::file_size(outputs[1])}},
                                      {{"kind", "manifest"}, {"path", path_text(outputs[5])}}});
        Json response{{"success", true},
                      {"exitCode", 0},
                      {"diagnostics", Json::array()},
                      {"outputDirectory", path_text(destination)},
                      {"archivePath", path_text(outputs[1])},
                      {"templateToken", descriptor.at("templateId").get<std::string>() + "@" +
                                            descriptor.at("buildId").get<std::string>()},
                      {"signingRequested", settings.signing_requested},
                      {"signingApplied", settings.signing_requested},
                      {"cancelled", false},
                      {"deployment", deployment}};
        if (symbols_requested) {
            response["symbolArchivePath"] = path_text(outputs[2]);
            artifacts.push_back({{"kind", "symbols"},
                                 {"path", path_text(outputs[2])},
                                 {"size", fs::file_size(outputs[2])}});
        }
        if (settings.dmg_requested)
            artifacts.push_back({{"kind", "dmg"},
                                 {"path", path_text(outputs[3])},
                                 {"size", fs::file_size(outputs[3])}});
        if (settings.signing_requested)
            artifacts.push_back({{"kind", "signing-report"}, {"path", path_text(outputs[4])}});
        response["artifacts"] = std::move(artifacts);
        return {std::move(response), "Native macOS platform export succeeded."};
    } catch (const ExportCancelled& error) {
        auto cancelled = failure("export-cancelled", error.what(), 130);
        cancelled.envelope["cancelled"] = true;
        return cancelled;
    } catch (const SourceChanged& error) {
        return failure("WORKSPACE_REVISION_CONFLICT", error.what(), 5);
    } catch (const std::exception& error) {
        return failure("platform-staging-failed", error.what());
    }
}

std::string android_xml_escape(std::string_view value)
{
    std::string output;
    for (char c : value) {
        switch (c) {
        case '&':
            output += "&amp;";
            break;
        case '<':
            output += "&lt;";
            break;
        case '>':
            output += "&gt;";
            break;
        case '"':
            output += "&quot;";
            break;
        case '\'':
            output += "&apos;";
            break;
        default:
            if (static_cast<unsigned char>(c) < 32 && c != '\n' && c != '\t')
                throw std::runtime_error("Invalid Android application label character.");
            output += c;
        }
    }
    return output;
}

std::string android_property(std::string_view value)
{
    std::string result;
    for (char c : value) {
        if (c == '\n')
            result += "\\n";
        else if (c == '\r')
            result += "\\r";
        else {
            if (c == '\\' || c == '=' || c == ':')
                result += '\\';
            result += c;
        }
    }
    return result;
}

std::string android_env(const char* name)
{
    const char* value = std::getenv(name);
    return value ? std::string(value) : std::string{};
}

std::string android_secret(const Json& signer, std::string_view name)
{
    const auto reference = signer.at(std::string(name)).get<std::string>();
    if (!reference.starts_with("env:") || reference.size() <= 4)
        throw std::runtime_error("Android signing secrets must use env:VARIABLE references.");
    const auto variable = reference.substr(4);
    if (!std::all_of(variable.begin(), variable.end(),
                     [](unsigned char c) { return std::isalnum(c) || c == '_'; }))
        throw std::runtime_error("Android signing environment variable name is invalid.");
    const auto secret = android_env(variable.c_str());
    if (secret.empty() || secret.find_first_of("\r\n") != std::string::npos)
        throw std::runtime_error("Android signing environment variable is unset or invalid: " +
                                 variable);
    return secret;
}

std::map<std::string, std::string> android_zip_entries(const fs::path& archive,
                                                       std::string_view prefix = {})
{
    mz_zip_archive reader{};
    const auto path = path_text(archive);
    if (!mz_zip_reader_init_file(&reader, path.c_str(), 0))
        throw std::runtime_error("Android APK/AAB/APK-set is not a valid ZIP archive.");
    struct Close {
        mz_zip_archive* reader;
        ~Close() { mz_zip_reader_end(reader); }
    } close{&reader};
    std::map<std::string, std::string> result;
    const auto count = mz_zip_reader_get_num_files(&reader);
    if (count > 20000)
        throw std::runtime_error("Android artifact contains too many ZIP entries.");
    for (mz_uint i = 0; i < count; ++i) {
        if (mz_zip_reader_is_file_a_directory(&reader, i))
            continue;
        mz_zip_archive_file_stat stat{};
        if (!mz_zip_reader_file_stat(&reader, i, &stat))
            throw std::runtime_error("Android artifact ZIP entry cannot be read.");
        const auto name_length = mz_zip_reader_get_filename(&reader, i, nullptr, 0);
        if (name_length == 0 || name_length > 4096)
            throw std::runtime_error("Android ZIP member has an invalid filename.");
        std::string name(name_length + 1, '\0');
        if (!mz_zip_reader_get_filename(&reader, i, name.data(), static_cast<mz_uint>(name.size())))
            throw std::runtime_error("Android ZIP member filename is unreadable.");
        name.resize(std::strlen(name.c_str()));
        if (name.empty() || name.front() == '/' || name.find("..") != std::string::npos ||
            name.find('\\') != std::string::npos)
            throw std::runtime_error("Android artifact contains an unsafe ZIP path.");
        // Limit decompression. The package is verified independently against
        // its freshly prepared bytes; other entries must not be ZIP bombs.
        if (stat.m_uncomp_size > 1024ull * 1024ull * 1024ull)
            throw std::runtime_error("Android artifact has an oversized ZIP entry.");
        if (!prefix.empty() && !name.starts_with(prefix))
            continue;
        if (prefix.empty() && !name.starts_with("assets/noveltea/bootstrap/") &&
            !name.starts_with("base/assets/noveltea/bootstrap/") &&
            !name.starts_with("assets/system/") && !name.starts_with("base/assets/system/") &&
            !name.starts_with("lib/") && !name.starts_with("base/lib/")) {
            result.emplace(name, std::string{});
            continue;
        }
        size_t size = 0;
        void* buffer = mz_zip_reader_extract_to_heap(&reader, i, &size, 0);
        if (!buffer)
            throw std::runtime_error("Android artifact ZIP entry fails CRC/readback: " + name);
        std::string bytes(static_cast<const char*>(buffer), size);
        mz_free(buffer);
        if (!result.emplace(name, std::move(bytes)).second)
            throw std::runtime_error("Android artifact has duplicate ZIP entries.");
    }
    return result;
}

PlatformCliResult stage_android_export(const Json& admission, const Json& profile,
                                       const Json& descriptor, const fs::path& template_directory,
                                       const fs::path& icon_source, const fs::path& destination,
                                       bool force, bool allow_localization_warnings,
                                       bool include_unused_assets, bool include_shader_sources,
                                       const PlatformResolvedExportSettings& settings,
                                       const PlatformExportTools& tools,
                                       const std::function<bool()>& source_current)
{
    if (!tools.prepare_package || !tools.resize_image || !tools.physical_sources_current ||
        !tools.run_signing_command || !tools.inspect_command)
        return failure("CLI_INTERNAL",
                       "Android export requires native package, image and host-tool adapters.", 70);
    try {
        check_cancellation(tools);
        if (!source_current())
            return failure("WORKSPACE_REVISION_CONFLICT",
                           "Android Project sources changed before export.", 5);
        const auto& android = descriptor.at("android");
        const auto& selection = profile.at("android");
        const auto abi = selection.at("abi").get<std::string>();
        const auto min_sdk = selection.at("minSdk").get<int>();
        const auto artifact_kind = selection.at("artifact").get<std::string>();
        const auto flavor = profile.at("buildFlavor").get<std::string>();
        const auto module = android.at("applicationModule").get<std::string>();
        if ((abi != "arm64-v8a" && abi != "x86_64") ||
            (artifact_kind != "apk" && artifact_kind != "aab" && artifact_kind != "both") ||
            (flavor != "debug" && flavor != "release") || module.empty() ||
            !std::all_of(module.begin(), module.end(),
                         [](unsigned char c) { return std::isalnum(c) || c == '_' || c == '-'; }))
            return failure("platform-artifact-invalid",
                           "Unsupported Android ABI, flavor or artifact configuration.");
        if (min_sdk < 24 || min_sdk > android.at("compileSdk").get<int>())
            return failure("android-min-sdk-range",
                           "Android minimum SDK is outside the template-supported range.");
        if (settings.signing_requested && flavor != "release")
            return failure("android-signing-debug-profile",
                           "Android release signing requires a release profile.");
        const auto sdk =
            settings.toolchains.value("androidSdk", android_env("ANDROID_SDK_ROOT").empty()
                                                        ? android_env("ANDROID_HOME")
                                                        : android_env("ANDROID_SDK_ROOT"));
        const auto java = settings.toolchains.value("javaHome", android_env("JAVA_HOME"));
        if (sdk.empty() || java.empty())
            return failure("android-toolchain-missing",
                           "Configure toolchains.androidSdk and toolchains.javaHome (or "
                           "ANDROID_SDK_ROOT and JAVA_HOME).");
        const auto executable = [](fs::path path) {
#if defined(_WIN32)
            path += ".exe";
#endif
            return path;
        };
        const auto build_tools_version =
            android.at("toolchain").at("buildTools").get<std::string>();
        const auto sdk_root = native_path_from_utf8(sdk);
        const auto java_root = native_path_from_utf8(java);
        const auto build_tools = sdk_root / "build-tools" / build_tools_version;
        const auto aapt2 = executable(build_tools / "aapt2");
        const auto zipalign = executable(build_tools / "zipalign");
#if defined(_WIN32)
        const auto apksigner = build_tools / "lib/apksigner.jar";
#else
        const auto apksigner = build_tools / "apksigner";
#endif
        const auto javabin = executable(java_root / "bin" / "java");
        const auto platform_jar =
            sdk_root / "platforms" /
            ("android-" + std::to_string(android.at("compileSdk").get<int>())) / "android.jar";
        const auto required =
            std::array{std::pair{"Java", javabin}, std::pair{"Android platform SDK", platform_jar},
                       std::pair{"aapt2", aapt2}, std::pair{"zipalign", zipalign},
                       std::pair{"apksigner", apksigner}};
        for (const auto& [label, path] : required)
            if (!fs::is_regular_file(fs::symlink_status(path)))
                return failure("android-toolchain-missing",
                               "Missing " + std::string(label) + ": " + path_text(path));
        const auto java_release = java_root / "release";
        if (!fs::is_regular_file(fs::symlink_status(java_release)) ||
            read_file(java_release)
                    .find("JAVA_VERSION=\"" +
                          android.at("toolchain").at("java").get<std::string>() + ".") ==
                std::string::npos)
            return failure("android-toolchain-version",
                           "Android template requires Java " +
                               android.at("toolchain").at("java").get<std::string>() +
                               " (JAVA_HOME/release mismatch).");
        const auto descriptor_sha = digest(read_file(template_directory / "template.json"));
        const auto registry_sha = digest(read_file(template_directory / ".noveltea-template.json"));
        const auto icon_sha = digest(read_file(icon_source));
        if (Json::parse(read_file(template_directory / "template.json")) != descriptor)
            return failure("platform-template-changed", "Android template changed after preflight.",
                           5);

        const auto nonce = random_nonce();
        const PublicationEntry entry{
            destination, native_path_from_utf8(path_text(destination) + ".stage-" + nonce),
            native_path_from_utf8(path_text(destination) + ".previous-" + nonce),
            fs::exists(fs::symlink_status(destination))};
        if (fs::exists(fs::symlink_status(entry.stage)) ||
            fs::exists(fs::symlink_status(entry.previous)) ||
            fs::is_symlink(fs::symlink_status(destination)) || (entry.had_previous && !force))
            return failure("platform-output-exists",
                           "Android export output is occupied or unsafe.");
        const std::vector<PublicationEntry> entries{entry};
        Staging cleanup(entries, journal_path(destination));
        const auto scratch =
            native_path_from_utf8(path_text(destination) + ".android-work-" + nonce);
        if (fs::exists(fs::symlink_status(scratch)))
            return failure("platform-output-exists", "Android build work directory is occupied.");
        struct ScratchCleanup {
            fs::path path;
            ~ScratchCleanup()
            {
                std::error_code error;
                fs::remove_all(path, error);
            }
        } clear_scratch{scratch};
        const auto project = scratch / "template";
        const auto generated = scratch / "generated";
        fs::create_directories(project);
        fs::create_directories(entry.stage);
        for (const auto& file : descriptor.at("files")) {
            check_cancellation(tools);
            const auto relative = file.at("path").get<std::string>();
            const auto source = safe_child(template_directory, relative);
            if (!fs::is_regular_file(fs::symlink_status(source)) ||
                fs::file_size(source) != file.at("size").get<std::uint64_t>() ||
                digest(read_file(source)) != file.at("sha256").get<std::string>())
                return failure("invalid-installed-template",
                               "Android template bytes changed: " + relative, 5);
            const auto target = safe_child(project, relative);
            copy_verified_file(source, target);
            fs::permissions(target,
                            static_cast<fs::perms>(file.at("mode").get<std::uint32_t>() & 0777),
                            fs::perm_options::replace);
        }
        const auto gradle_root =
            safe_child(project, android.at("gradleProjectRoot").get<std::string>());
        const auto gradlew =
            safe_child(project, android.at("gradleWrapperPath").get<std::string>());
        const auto gradle_wrapper = gradle_root / "gradle/wrapper/gradle-wrapper.jar";
        const auto bundletool =
            safe_child(project, android.at("bundletoolPath").get<std::string>());
        if (!fs::is_regular_file(fs::symlink_status(gradlew)) ||
            !fs::is_regular_file(fs::symlink_status(gradle_wrapper)) ||
            !fs::is_regular_file(fs::symlink_status(bundletool)))
            return failure("android-toolchain-missing",
                           "Android Gradle wrapper or pinned bundletool is missing.");
        const auto gradle_properties =
            read_file(gradle_root / "gradle/wrapper/gradle-wrapper.properties");
        if (gradle_properties.find("gradle-" +
                                   android.at("toolchain").at("gradle").get<std::string>() + "-") ==
            std::string::npos)
            return failure("android-toolchain-version",
                           "Android template Gradle wrapper does not match the pinned version.");
        const std::vector<std::string> environment{"JAVA_HOME=" + java, "ANDROID_HOME=" + sdk,
                                                   "ANDROID_SDK_ROOT=" + sdk};
        const auto run = [&](std::string program, std::vector<std::string> args) {
#if !defined(_WIN32)
            args.insert(args.begin(), environment.begin(), environment.end());
            args.insert(args.begin() + static_cast<std::ptrdiff_t>(environment.size()), program);
            return tools.run_signing_command("env", args, gradle_root);
#else
            return tools.run_signing_command(program, args, gradle_root);
#endif
        };
        const auto inspect = [&](std::string program, std::vector<std::string> args) {
#if !defined(_WIN32)
            args.insert(args.begin(), environment.begin(), environment.end());
            args.insert(args.begin() + static_cast<std::ptrdiff_t>(environment.size()), program);
            return tools.inspect_command("env", args, gradle_root);
#else
            return tools.inspect_command(program, args, gradle_root);
#endif
        };
        // Launch the pinned wrapper JAR directly. This preserves argv boundaries
        // on Windows too, where CreateProcessW cannot execute gradlew.bat
        // without a shell (and its quoting/argument-injection hazards).
        const auto gradle = [&](std::vector<std::string> args) {
            args.insert(args.begin(),
                        {"-cp", path_text(gradle_wrapper), "org.gradle.wrapper.GradleWrapperMain"});
            return run(path_text(javabin), std::move(args));
        };
        const auto verify_apk_signature = [&](const fs::path& apk) {
#if defined(_WIN32)
            return run(path_text(javabin),
                       {"-cp", path_text(apksigner), "com.android.apksigner.ApkSignerTool",
                        "verify", "--verbose", path_text(apk)});
#else
            return run(path_text(apksigner), {"verify", "--verbose", path_text(apk)});
#endif
        };
        if (!run(path_text(javabin), {"-version"}) || !gradle({"--version"}))
            return failure(
                "android-toolchain-version",
                "Java or the pinned Gradle wrapper cannot execute; check JDK/SDK configuration.");

        Json native_profile = admission.at("profile");
        native_profile["shaderVariants"] = Json::array({"essl-300"});
        native_profile["localization"] = profile.at("localization");
        native_profile["excludeUnusedAssets"] =
            include_unused_assets ? false : profile.value("excludeUnusedAssets", true);
        native_profile["includeShaderSources"] =
            include_shader_sources || profile.value("includeShaderSources", false);
        native_profile["stripShaderSources"] =
            !native_profile.at("includeShaderSources").get<bool>();
        if (tools.progress)
            tools.progress("writing-package", "Preparing Android essl-300 runtime package");
        const auto bootstrap = generated / "assets/noveltea/bootstrap";
        const auto package_file = bootstrap / "game.ntpkg";
        const auto packaged = tools.prepare_package(admission, native_profile, package_file);
        check_cancellation(tools);
        if (!packaged.value("ok", false))
            return failure(packaged.value("code", "native.platform.package"),
                           packaged.value("error", "Android runtime package failed."), 6);
        const auto& artifact = packaged.at("artifact");
        if (!artifact.contains("compiledProject") ||
            artifact.at("packageOptions").value("kind", "") != "runtime")
            return failure("native.runtime.artifact",
                           "Android runtime package evidence is invalid.", 6);
        const auto& options = artifact.at("packageOptions");
        for (const auto& finding : artifact.value("diagnostics", Json::array()))
            if (finding.value("severity", "") == "warning" &&
                finding.value("code", std::string{}).starts_with("localization.export.") &&
                !allow_localization_warnings)
                return failure("localization.export.warning_override_required",
                               "Localization warnings require --allow-localization-warnings.");
        const auto package_sha = digest(read_file(package_file));
        const auto& app = admission.at("project").at("settings").at("app");
        const auto& app_android = app.at("android");
        const auto name = app.at("displayName").get<std::string>();
        const auto app_id = app_android.value("applicationId", std::string{}).empty()
                                ? app.at("applicationId").get<std::string>()
                                : app_android.at("applicationId").get<std::string>();
        const auto version = app.at("versionName").get<std::string>();
        const auto version_code = app_android.value("versionCode", app.value("buildNumber", 1));
        const auto backup = app_android.value("allowBackup", false);
        const auto is_game = app_android.value("isGame", true);
        if (version_code < 1)
            return failure("android-version-code", "Android versionCode must be positive.");
        const auto& resolution = options.at("display").at("reference_resolution");
        const int width = resolution.at("width").get<int>();
        const int height = resolution.at("height").get<int>();
        if (width <= 0 || height <= 0)
            return failure("platform-runtime-display", "Android reference resolution is invalid.");
        const auto orientation = width >= height ? "landscape" : "portrait";
        const auto divisor = std::gcd(width, height);
        const Json display{{"referenceResolution", resolution},
                           {"worldRasterPolicy", options.at("display").at("world_raster_policy")},
                           {"barColor", options.at("display").at("bar_color")}};
        const Json accessibility{{"uiScale", options.at("accessibility").at("ui_scale")},
                                 {"textScale", options.at("accessibility").at("text_scale")}};
        const auto& memory = profile.at("assetMemory");
        if (memory.value("kind", "") != "builtin")
            return failure("platform-asset-memory-policy",
                           "Native Android custom memory policies are not yet supported.", 70);
        const std::map<std::string, std::array<std::uint64_t, 7>> baselines{
            {"low", {50331648, 369098752, 25165824, 25165824, 7549747, 268435456, 3774873}},
            {"balanced", {100663296, 738197504, 50331648, 50331648, 25165824, 536870912, 12582912}},
            {"high",
             {201326592, 1476395008, 100663296, 100663296, 70464307, 1073741824, 35232153}}};
        const auto preset = memory.at("preset").get<std::string>();
        if (!baselines.contains(preset))
            return failure("platform-asset-memory-policy", "Unknown Android asset memory preset.");
        const auto& b = baselines.at(preset);
        const Json asset_memory{{"preset", preset},       {"preparedCpuBytes", b[0]},
                                {"gpuBytes", b[1]},       {"audioBytes", b[2]},
                                {"temporaryBytes", b[3]}, {"warmPreparedCpuBytes", b[4]},
                                {"warmGpuBytes", b[5]},   {"warmAudioBytes", b[6]}};
        const Json capabilities = Json::array({"external-url", "vibration"});
        const Json metadata{{"androidPermissions", Json::array({"android.permission.VIBRATE"})},
                            {"androidFeatures", Json::array()},
                            {"webRequirements", Json::array({"external-navigation", "vibration"})},
                            {"desktopFeatures", Json::array()}};
        Json player{{"format", "noveltea.player-config"},
                    {"formatVersion", 1},
                    {"displayName", name},
                    {"applicationId", app_id},
                    {"saveNamespace", app.at("saveNamespace")},
                    {"versionName", version},
                    {"package", {{"path", "game.ntpkg"}, {"sha256", package_sha}}},
                    {"capabilities", capabilities},
                    {"display", display},
                    {"accessibility", accessibility},
                    {"assetMemory", asset_memory}};
        if (app.contains("defaultLocale"))
            player["defaultLocale"] = app.at("defaultLocale");
        write_file(bootstrap / "player.json", player.dump(2) + '\n');
        const auto& res = generated / "res";
        write_file(res / "values/strings.xml", "<resources><string name=\"noveltea_app_name\">" +
                                                   android_xml_escape(name) +
                                                   "</string></resources>\n");
        write_file(
            res / "values/colors.xml",
            "<resources><color name=\"noveltea_launch_background\">" +
                android_xml_escape(app.value("launchBackgroundColor", std::string("#000000"))) +
                "</color></resources>\n");
        write_file(res / "values/styles.xml",
                   "<resources><style name=\"NovelTeaGeneratedTheme\" "
                   "parent=\"android:Theme.NoTitleBar.Fullscreen\"><item "
                   "name=\"android:windowFullscreen\">true</item><item "
                   "name=\"android:windowBackground\">@color/noveltea_launch_background</item></"
                   "style></resources>\n");
        write_file(res / "values-v31/styles.xml",
                   "<resources><style name=\"NovelTeaGeneratedTheme\" "
                   "parent=\"android:Theme.NoTitleBar.Fullscreen\"><item "
                   "name=\"android:windowSplashScreenBackground\">@color/"
                   "noveltea_launch_background</item><item "
                   "name=\"android:windowSplashScreenAnimatedIcon\">@mipmap/ic_launcher</item></"
                   "style></resources>\n");
        write_file(res / "xml/backup_rules.xml",
                   backup ? "<full-backup-content />\n"
                          : "<full-backup-content><exclude domain=\"root\" path=\".\" "
                            "/></full-backup-content>\n");
        write_file(res / "xml/data_extraction_rules.xml",
                   backup ? "<data-extraction-rules><cloud-backup /><device-transfer "
                            "/></data-extraction-rules>\n"
                          : "<data-extraction-rules><cloud-backup><exclude domain=\"root\" "
                            "path=\".\" /></cloud-backup><device-transfer><exclude domain=\"root\" "
                            "path=\".\" /></device-transfer></data-extraction-rules>\n");
        std::string manifest =
            "<?xml version=\"1.0\" encoding=\"utf-8\"?>\n<manifest "
            "xmlns:android=\"http://schemas.android.com/apk/res/android\">\n"
            "<uses-permission android:name=\"android.permission.VIBRATE\" />\n"
            "<uses-feature android:glEsVersion=\"0x00030000\" android:required=\"true\" />\n"
            "<application android:allowBackup=\"" +
            std::string(backup ? "true" : "false") +
            "\" android:dataExtractionRules=\"@xml/data_extraction_rules\" "
            "android:fullBackupContent=\"@xml/backup_rules\" android:hasCode=\"true\" "
            "android:icon=\"@mipmap/ic_launcher\" android:roundIcon=\"@mipmap/ic_launcher_round\" "
            "android:label=\"@string/noveltea_app_name\" "
            "android:theme=\"@style/NovelTeaGeneratedTheme\"" +
            (is_game ? " android:appCategory=\"game\"" : "") +
            ">\n"
            "<activity android:name=\"" +
            android_xml_escape(android.at("activityClass").get<std::string>()) +
            "\" android:configChanges=\"orientation|screenSize|screenLayout|keyboardHidden\" "
            "android:exported=\"true\" android:screenOrientation=\"sensor" +
            std::string(orientation == "portrait" ? "Portrait" : "Landscape") +
            "\" android:theme=\"@style/NovelTeaGeneratedTheme\"><meta-data "
            "android:name=\"android.app.lib_name\" android:value=\"" +
            android_xml_escape(android.at("nativeLibraryName").get<std::string>()) +
            "\"/><intent-filter><action android:name=\"android.intent.action.MAIN\"/><category "
            "android:name=\"android.intent.category.LAUNCHER\"/></intent-filter></activity></"
            "application></manifest>\n";
        write_file(generated / "AndroidManifest.xml", manifest);
        for (const auto& [qualifier, size] : std::array<std::pair<const char*, int>, 5>{
                 {{"mdpi", 48}, {"hdpi", 72}, {"xhdpi", 96}, {"xxhdpi", 144}, {"xxxhdpi", 192}}}) {
            for (const auto& suffix :
                 {"ic_launcher", "ic_launcher_round", "ic_launcher_foreground"}) {
                const auto filename = "mipmap-" + std::string(qualifier) + "/" + suffix + ".png";
                const auto generated_icon = res / filename;
                fs::create_directories(generated_icon.parent_path());
                const auto resized = tools.resize_image({{"sourcePath", path_text(icon_source)},
                                                         {"outputPath", path_text(generated_icon)},
                                                         {"size", size}});
                if (!resized.value("ok", false))
                    return failure("platform-icon-generation",
                                   resized.value("error", "Android icon generation failed."));
            }
        }
        const auto adaptive =
            "<adaptive-icon "
            "xmlns:android=\"http://schemas.android.com/apk/res/android\"><background "
            "android:drawable=\"@color/noveltea_launch_background\"/><foreground "
            "android:drawable=\"@mipmap/ic_launcher_foreground\"/></adaptive-icon>\n";
        for (const auto& suffix : {"ic_launcher", "ic_launcher_round"})
            write_file(res / (std::string("mipmap-anydpi-v26/") + suffix + ".xml"), adaptive);
        for (const auto& file : descriptor.at("files")) {
            const auto relative = file.at("path").get<std::string>();
            if (relative.starts_with("licenses/"))
                copy_verified_file(safe_child(project, relative),
                                   safe_child(gradle_root / "prebuilt-system", relative));
        }
        const auto properties_path = generated / "noveltea.properties";
        write_file(properties_path, "novelteaApplicationId=" + android_property(app_id) +
                                        "\nnovelteaVersionCode=" + std::to_string(version_code) +
                                        "\nnovelteaVersionName=" + android_property(version) +
                                        "\nnovelteaAbi=" + abi +
                                        "\nnovelteaMinSdk=" + std::to_string(min_sdk) +
                                        "\nnovelteaOrientation=" + orientation + "\n");
        write_file(gradle_root / "local.properties", "sdk.dir=" + android_property(sdk) + "\n");
        std::vector<std::string> extra;
        if (settings.signing_requested) {
            const auto& signer = settings.signing.at("android");
            const auto keystore =
                native_path_from_utf8(signer.at("keystorePath").get<std::string>());
            if (!fs::is_regular_file(fs::symlink_status(keystore)))
                return failure("android-signing-keystore-missing",
                               "Configured Android keystore is not a regular file.");
            const auto signing_file = scratch / "signing.properties";
            write_file(
                signing_file,
                "storeFile=" + android_property(path_text(fs::absolute(keystore))) +
                    "\nstorePassword=" +
                    android_property(android_secret(signer, "storePasswordReference")) +
                    "\nkeyAlias=" + android_property(signer.at("keyAlias").get<std::string>()) +
                    "\nkeyPassword=" +
                    android_property(android_secret(signer, "keyPasswordReference")) + "\n");
            fs::permissions(signing_file, static_cast<fs::perms>(0600), fs::perm_options::replace);
            extra.push_back("-PnovelteaSigningProperties=" + path_text(signing_file));
        }
        const auto gradle_flavor = flavor == "release" ? "Release" : "Debug";
        const auto gradle_args = [&]() {
            std::vector<std::string> args{
                "--no-daemon",
                "-PnovelteaCompileShaders=OFF",
                "-PnovelteaPrebuiltShaderAssetRoot=" + path_text(gradle_root / "prebuilt-shaders"),
                "-PnovelteaPrebuiltNativeRoot=" + path_text(gradle_root / "prebuilt-native"),
                "-PnovelteaSystemAssetRoot=" + path_text(gradle_root / "prebuilt-system"),
                "-PnovelteaGeneratedRoot=" + path_text(generated),
                "-PnovelteaGeneratedProperties=" + path_text(properties_path)};
            args.insert(args.end(), extra.begin(), extra.end());
            return args;
        }();
        const bool with_apk = artifact_kind != "aab";
        const bool with_aab = artifact_kind != "apk";
        for (const auto& task : {std::pair{with_apk, "assemble"}, std::pair{with_aab, "bundle"}}) {
            if (!task.first)
                continue;
            check_cancellation(tools);
            if (tools.progress)
                tools.progress("packaging",
                               "Building Android " + std::string(task.second) + " artifact");
            auto args = gradle_args;
            args.insert(args.begin(), ":" + module + ":" + task.second + gradle_flavor);
            if (!gradle(std::move(args)))
                return failure("android-gradle-failed",
                               "Android Gradle " + std::string(task.second) +
                                   " failed. Check SDK/JDK, template inputs and signing "
                                   "configuration; credentials are not logged.");
        }
        const auto safe_name = [](std::string value) {
            std::string output;
            for (unsigned char c : value) {
                if (std::isalnum(c) || c == '_' || c == '.' || c == '-')
                    output += static_cast<char>(c);
                else if (!output.empty() && output.back() != '-')
                    output += '-';
            }
            while (!output.empty() && output.back() == '-')
                output.pop_back();
            while (!output.empty() && output.front() == '-')
                output.erase(output.begin());
            return output.empty() ? std::string("game") : output;
        };
        const auto stem =
            safe_name(app.value("shortName", name)) + "-" + safe_name(version) + "-android-" + abi;
        Json outputs = Json::array();
        const auto append = [&](const std::string& kind, const fs::path& from) {
            const auto target = entry.stage / (stem + "." + kind);
            const auto size = fs::file_size(from);
            if (size > (kind == "apk" ? 200ull : 1024ull) * 1024ull * 1024ull)
                throw std::runtime_error("Android artifact exceeds the certified size limit.");
            copy_verified_file(from, target);
            outputs.push_back({{"kind", kind},
                               {"file", path_text(target.filename())},
                               {"size", fs::file_size(target)},
                               {"sha256", digest(read_file(target))}});
        };
        if (with_apk)
            append("apk",
                   gradle_root / module / "build/outputs/apk" / flavor /
                       (module + "-" + flavor +
                        (flavor == "release" && !settings.signing_requested ? "-unsigned" : "") +
                        ".apk"));
        if (with_aab)
            append("aab", gradle_root / module / "build/outputs/bundle" / flavor /
                              (module + "-" + flavor + ".aab"));
        const auto verify = [&](const fs::path& root) {
            for (const auto& output : outputs) {
                const auto kind = output.at("kind").get<std::string>();
                const auto path = root / output.at("file").get<std::string>();
                if (digest(read_file(path)) != output.at("sha256").get<std::string>())
                    throw std::runtime_error("Android artifact bytes changed during publication.");
                const std::string prefix = kind == "apk" ? "" : "base/";
                const auto entries = android_zip_entries(path);
                const auto game = prefix + "assets/noveltea/bootstrap/game.ntpkg";
                const auto config = prefix + "assets/noveltea/bootstrap/player.json";
                if (!entries.contains(game) || digest(entries.at(game)) != package_sha ||
                    !entries.contains(config) || Json::parse(entries.at(config)) != player)
                    throw std::runtime_error("Android bootstrap package or player config differs "
                                             "from prepared runtime.");
                const auto library_prefix = prefix + "lib/";
                std::set<std::string> expected, actual;
                const auto template_prefix = "source/android/prebuilt-native/" + abi + "/";
                for (const auto& file : descriptor.at("files")) {
                    const auto name = file.at("path").get<std::string>();
                    if (name.starts_with(template_prefix) && name.ends_with(".so"))
                        expected.insert(name.substr(template_prefix.size()));
                }
                for (const auto& [name, bytes] : entries) {
                    (void)bytes;
                    if (name.starts_with(library_prefix) && name.ends_with(".so")) {
                        if (!name.starts_with(library_prefix + abi + "/"))
                            throw std::runtime_error(
                                "Android artifact includes an unexpected ABI.");
                        actual.insert(name.substr((library_prefix + abi + "/").size()));
                    }
                }
                if (actual.empty() || actual != expected)
                    throw std::runtime_error(
                        "Android artifact native-library closure disagrees with template.");
                constexpr std::string_view system_prefix = "source/android/prebuilt-system/";
                for (const auto& file : descriptor.at("files")) {
                    const auto name = file.at("path").get<std::string>();
                    if (!name.starts_with(system_prefix))
                        continue;
                    const auto mounted =
                        prefix + "assets/system/" + name.substr(system_prefix.size());
                    if (!entries.contains(mounted) ||
                        digest(entries.at(mounted)) != file.at("sha256").get<std::string>())
                        throw std::runtime_error(
                            "Android system font or shader bytes differ from the template.");
                }
                std::set<std::string> notices;
                for (const auto& file : descriptor.at("files")) {
                    const auto name = file.at("path").get<std::string>();
                    if (!name.starts_with("licenses/"))
                        continue;
                    const auto mounted = prefix + "assets/system/" + name;
                    if (!entries.contains(mounted) ||
                        digest(entries.at(mounted)) != file.at("sha256").get<std::string>())
                        throw std::runtime_error(
                            "Android artifact engine license bytes differ from template.");
                    notices.insert(mounted);
                }
                for (const auto& [name, bytes] : entries) {
                    (void)bytes;
                    if (name.starts_with(prefix + "assets/system/licenses/") &&
                        !notices.contains(name))
                        throw std::runtime_error(
                            "Android artifact contains an undeclared engine license.");
                }
                if (kind == "apk") {
                    const auto badging =
                        inspect(path_text(aapt2), {"dump", "badging", path_text(path)});
                    const auto xmltree =
                        inspect(path_text(aapt2), {"dump", "xmltree", "--file",
                                                   "AndroidManifest.xml", path_text(path)});
                    const auto declared_package = "package: name='" + app_id + "' versionCode='" +
                                                  std::to_string(version_code) + "' versionName='" +
                                                  version + "'";
                    if (!badging || !badging->starts_with(declared_package) ||
                        badging->find("minSdkVersion:'" +
                                      std::to_string(selection.at("minSdk").get<int>()) + "'") ==
                            std::string::npos ||
                        badging->find("targetSdkVersion:'" +
                                      std::to_string(android.at("targetSdk").get<int>()) + "'") ==
                            std::string::npos ||
                        !xmltree ||
                        xmltree->find(":screenOrientation(0x0101001e)=" +
                                      std::string(orientation == "portrait" ? "7" : "6")) ==
                            std::string::npos ||
                        xmltree->find(":allowBackup(0x01010280)=" +
                                      std::string(backup ? "true" : "false")) ==
                            std::string::npos ||
                        xmltree->find(android.at("activityClass").get<std::string>()) ==
                            std::string::npos ||
                        xmltree->find(android.at("nativeLibraryName").get<std::string>()) ==
                            std::string::npos)
                        throw std::runtime_error(
                            "Android APK manifest identity, SDK, launcher, orientation or backup "
                            "policy differs from deployment.");
                    std::set<std::string> declared_permissions;
                    std::istringstream badges(*badging);
                    std::string line;
                    constexpr std::string_view permission_prefix = "uses-permission: name='";
                    while (std::getline(badges, line)) {
                        if (!line.starts_with(permission_prefix))
                            continue;
                        const auto ending = line.find('\'', permission_prefix.size());
                        if (ending == std::string::npos)
                            throw std::runtime_error(
                                "Malformed Android APK permission declaration.");
                        declared_permissions.insert(line.substr(permission_prefix.size(),
                                                                ending - permission_prefix.size()));
                    }
                    if (declared_permissions != std::set<std::string>{"android.permission.VIBRATE"})
                        throw std::runtime_error(
                            "Android APK permissions differ from declared capabilities.");
                    const auto category = xmltree->find(":appCategory(");
                    const auto classified_as_game =
                        category != std::string::npos &&
                        xmltree->find(")=0", category) != std::string::npos &&
                        xmltree->find(")=0", category) - category < 48;
                    if (xmltree->find(":dataExtractionRules(") == std::string::npos ||
                        xmltree->find(":fullBackupContent(") == std::string::npos ||
                        (is_game && !classified_as_game))
                        throw std::runtime_error(
                            "Android APK backup and game classification differs from deployment.");
                    std::size_t components = 0;
                    for (const auto& element :
                         {"E: activity ", "E: service ", "E: receiver ", "E: provider "}) {
                        std::size_t cursor = 0;
                        while ((cursor = xmltree->find(element, cursor)) != std::string::npos) {
                            ++components;
                            cursor += std::strlen(element);
                        }
                    }
                    if (components != 1)
                        throw std::runtime_error(
                            "Android APK contains unexpected manifest components.");
                    if (!run(path_text(zipalign), {"-c", "-P", "16", "4", path_text(path)}))
                        throw std::runtime_error("Android APK fails ZIP alignment certification.");
                    if ((settings.signing_requested || flavor == "debug") &&
                        !verify_apk_signature(path))
                        throw std::runtime_error("Android APK signature verification failed.");
                }
                if (kind == "aab") {
                    const auto jarsigner = executable(java_root / "bin" / "jarsigner");
                    if (!fs::is_regular_file(fs::symlink_status(jarsigner)))
                        throw std::runtime_error(
                            "Java jarsigner is required to inspect Android AAB signatures.");
                    const auto signature = inspect(
                        path_text(jarsigner), {"-verify", "-verbose", "-certs", path_text(path)});
                    const bool signed_bundle =
                        signature && signature->find("jar verified.") != std::string::npos &&
                        signature->find("jar is unsigned") == std::string::npos;
                    if (signed_bundle != settings.signing_requested)
                        throw std::runtime_error("Android AAB signature does not match requested "
                                                 "release signing policy.");
                }
            }
        };
        verify(entry.stage);
        if (with_aab) {
            const auto aab = entry.stage / (stem + ".aab");
            const auto apks = scratch / "derived.apks";
            if (!run(path_text(javabin),
                     {"-jar", path_text(bundletool), "build-apks", "--bundle=" + path_text(aab),
                      "--output=" + path_text(apks), "--mode=universal", "--overwrite"}))
                return failure("android-bundletool-verification-failed",
                               "Pinned bundletool could not build a universal APK from the AAB.");
            const auto universal = android_zip_entries(apks, "universal.apk");
            if (!universal.contains("universal.apk"))
                return failure("android-bundletool-verification-failed",
                               "Bundletool APK set omits universal.apk.");
            const auto derived = scratch / "universal.apk";
            write_file(derived, universal.at("universal.apk"));
            const auto derived_entries = android_zip_entries(derived);
            if (!derived_entries.contains("assets/noveltea/bootstrap/game.ntpkg") ||
                digest(derived_entries.at("assets/noveltea/bootstrap/game.ntpkg")) != package_sha ||
                !derived_entries.contains("assets/noveltea/bootstrap/player.json") ||
                Json::parse(derived_entries.at("assets/noveltea/bootstrap/player.json")) != player)
                return failure("android-bundletool-verification-failed",
                               "Derived universal APK runtime package does not match the AAB.");
            const auto derived_badging =
                inspect(path_text(aapt2), {"dump", "badging", path_text(derived)});
            if (!derived_badging ||
                derived_badging->find("package: name='" + app_id + "' versionCode='" +
                                      std::to_string(version_code) + "'") == std::string::npos ||
                !verify_apk_signature(derived))
                return failure("android-bundletool-verification-failed",
                               "Derived universal APK has invalid identity or signature.");
        }
        Json deployment{
            {"target", "android"},
            {"architecture", profile.at("architecture")},
            {"buildFlavor", flavor},
            {"applicationId", app_id},
            {"displayName", name},
            {"versionName", version},
            {"saveNamespace", app.at("saveNamespace")},
            {"capabilities", capabilities},
            {"capabilityMetadata", metadata},
            {"display",
             {{"aspectRatio", {{"width", width / divisor}, {"height", height / divisor}}},
              {"orientation", orientation},
              {"barColor", display.at("barColor")}}},
            {"packageAccess", profile.at("packageAccess")},
            {"templateId", descriptor.at("templateId")},
            {"buildId", descriptor.at("buildId")},
            {"compiledProjectFormatVersion", 1},
            {"playerRuntimeApiVersion", 1},
            {"assetMemory", asset_memory},
            {"android",
             {{"applicationId", app_id},
              {"versionCode", version_code},
              {"versionName", version},
              {"allowBackup", backup},
              {"isGame", is_game},
              {"minSdk", selection.at("minSdk")},
              {"targetSdk", android.at("targetSdk")},
              {"compileSdk", android.at("compileSdk")},
              {"abi", abi},
              {"artifacts", artifact_kind == "both" ? Json::array({"apk", "aab"})
                                                    : Json::array({artifact_kind})},
              {"packageAccess", profile.at("packageAccess")},
              {"orientation", orientation}}}};
        const auto report_name = stem + "-export-report.json";
        write_file(
            entry.stage / report_name,
            Json{{"format", "noveltea.android-export-report"},
                 {"deployment", deployment.at("android")},
                 {"template",
                  {{"id", descriptor.at("templateId")}, {"buildId", descriptor.at("buildId")}}},
                 {"package", {{"sha256", package_sha}}},
                 {"signing",
                  {{"requested", settings.signing_requested},
                   {"mode", settings.signing_requested ? "release-keystore"
                            : flavor == "debug"        ? "debug"
                                                       : "unsigned"}}},
                 {"artifacts", outputs},
                 {"verification",
                  {{"apkReadback", with_apk}, {"aabReadback", with_aab}, {"bundletool", with_aab}}}}
                    .dump(2) +
                '\n');
        const auto sources_fresh = [&]() {
            if (!source_current() || !tools.physical_sources_current(options) ||
                digest(read_file(icon_source)) != icon_sha ||
                digest(read_file(template_directory / "template.json")) != descriptor_sha ||
                digest(read_file(template_directory / ".noveltea-template.json")) != registry_sha)
                return false;
            for (const auto& file : descriptor.at("files"))
                if (digest(read_file(
                        safe_child(template_directory, file.at("path").get<std::string>()))) !=
                    file.at("sha256").get<std::string>())
                    return false;
            return true;
        };
        check_cancellation(tools);
        if (!sources_fresh())
            return failure("WORKSPACE_REVISION_CONFLICT",
                           "Android source or template changed before publication.", 5);
        publish(destination, entries, nonce, [&]() {
            check_cancellation(tools);
            verify(destination);
            if (!sources_fresh())
                throw SourceChanged("Android sources changed during publication.");
        });
        Json artifacts = Json::array();
        for (const auto& item : outputs)
            artifacts.push_back(
                {{"kind", item.at("kind")},
                 {"path", path_text(destination / item.at("file").get<std::string>())},
                 {"size", item.at("size")}});
        artifacts.push_back(
            {{"kind", "export-report"}, {"path", path_text(destination / report_name)}});
        return {{{"success", true},
                 {"exitCode", 0},
                 {"diagnostics", Json::array()},
                 {"outputDirectory", path_text(destination)},
                 {"templateToken", descriptor.at("templateId").get<std::string>() + "@" +
                                       descriptor.at("buildId").get<std::string>()},
                 {"signingRequested", settings.signing_requested},
                 {"signingApplied", settings.signing_requested},
                 {"cancelled", false},
                 {"deployment", deployment},
                 {"artifacts", artifacts}},
                "Native Android APK/AAB export succeeded."};
    } catch (const ExportCancelled& error) {
        auto cancelled = failure("export-cancelled", error.what(), 130);
        cancelled.envelope["cancelled"] = true;
        return cancelled;
    } catch (const SourceChanged& error) {
        return failure("WORKSPACE_REVISION_CONFLICT", error.what(), 5);
    } catch (const std::exception& error) {
        return failure("android-export-failed", error.what());
    }
}

} // namespace

std::optional<PlatformCliResult>
validate_native_platform_export_settings(const PlatformResolvedExportSettings& settings,
                                         const Json& profile)
{
    if (!settings.toolchains.is_object() || !settings.signing.is_object()) {
        auto invalid =
            failure("platform.config_invalid", "Resolved export configuration is invalid.");
        invalid.envelope["diagnostics"][0]["path"] = "/config";
        return invalid;
    }
    if (settings.signing_requested) {
        const auto target = profile.value("target", "");
        auto unavailable =
            !settings.signing.contains(target)
                ? failure("platform.signing_profile_required",
                          "No signing state was resolved for the selected target.")
                : failure("CLI_NATIVE_CANDIDATE_UNCLAIMED",
                          "Target-specific native signing and post-signing verification are not "
                          "implemented.",
                          70);
        if (target == "windows" && settings.signing.contains("windows")) {
            const auto& signer = settings.signing.at("windows");
            bool valid = signer.is_object();
            for (const char* name : {"command", "verifyCommand"})
                valid = valid && signer.contains(name) && signer.at(name).is_string() &&
                        !signer.at(name).get_ref<const std::string&>().empty();
            for (const char* name : {"args", "verifyArgs"}) {
                if (!valid || !signer.contains(name) || !signer.at(name).is_array()) {
                    valid = false;
                    break;
                }
                const auto& arguments = signer.at(name);
                valid = std::any_of(arguments.begin(), arguments.end(), [](const Json& argument) {
                    return argument.is_string() && argument.get_ref<const std::string&>().find(
                                                       "{subject}") != std::string::npos;
                });
            }
            if (!valid) {
                auto invalid = failure("platform.signing_configuration_invalid",
                                       "Windows signing and verification must each specify a "
                                       "command and the {subject} argument.");
                invalid.envelope["diagnostics"][0]["path"] = "/signingProfile";
                return invalid;
            }
            return std::nullopt;
        }
        if (target == "macos" && settings.signing.contains("macos")) {
            const auto& signer = settings.signing.at("macos");
            if (!signer.is_object() || !signer.contains("identity") ||
                !signer.at("identity").is_string() ||
                signer.at("identity").get<std::string>().empty())
                return failure("platform.signing_configuration_invalid",
                               "macOS signing requires a non-empty signing identity.");
#if !defined(__APPLE__)
            return failure("platform-macos-host-required", "macOS signing requires a macOS host.");
#else
            return std::nullopt;
#endif
        }
        if (target == "android" && settings.signing.contains("android")) {
            if (profile.value("buildFlavor", "") != "release")
                return failure("android-signing-debug-profile",
                               "Android release signing requires a release profile.");
            const auto& signer = settings.signing.at("android");
            if (!signer.is_object() || signer.size() != 4)
                return failure(
                    "platform.signing_configuration_invalid",
                    "Android signing requires a keystore, alias and two env: secret references.");
            for (const auto& name :
                 {"keystorePath", "keyAlias", "storePasswordReference", "keyPasswordReference"})
                if (!signer.contains(name) || !signer.at(name).is_string() ||
                    signer.at(name).get<std::string>().empty())
                    return failure("platform.signing_configuration_invalid",
                                   "Android signing field is missing or invalid.");
            for (const auto& name : {"storePasswordReference", "keyPasswordReference"})
                if (!signer.at(name).get<std::string>().starts_with("env:"))
                    return failure("platform.signing_configuration_invalid",
                                   "Android signing secrets must be env: references.");
            return std::nullopt;
        }
        unavailable.envelope["diagnostics"][0]["path"] = "/signingProfile";
        return unavailable;
    }
    if (settings.dmg_requested && profile.value("target", "") != "macos")
        return failure("platform-artifact-invalid", "DMG is only available for macOS.");
#if !defined(__APPLE__)
    if (settings.dmg_requested)
        return failure("platform-macos-host-required", "DMG creation requires a macOS host.");
#endif
    return std::nullopt;
}

void validate_platform_publication_path(const fs::path& destination)
{
    validate_parents(destination);
}

PlatformPublicationLock::PlatformPublicationLock(const fs::path& destination)
    : destination_(destination)
{
    validate_parents(destination_);
    fs::create_directories(destination_.parent_path());
    validate_parents(destination_);
    const auto lock_file =
        native_path_from_utf8(path_text(destination_) + ".noveltea-publication.lock");
    if (fs::is_symlink(fs::symlink_status(lock_file)))
        throw std::runtime_error("Symbolic-link platform publication lock is forbidden.");
#if defined(_WIN32)
    const HANDLE handle = CreateFileW(
        lock_file.c_str(), GENERIC_READ | GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE,
        nullptr, OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
    if (handle == INVALID_HANDLE_VALUE)
        throw std::runtime_error("Cannot open exclusive platform publication lock.");
    OVERLAPPED overlapped{};
    if (!LockFileEx(handle, LOCKFILE_EXCLUSIVE_LOCK | LOCKFILE_FAIL_IMMEDIATELY, 0, 1, 0,
                    &overlapped)) {
        CloseHandle(handle);
        throw std::runtime_error("Another publisher owns the platform output.");
    }
    handle_ = handle;
#else
    handle_ = open(lock_file.c_str(), O_CREAT | O_RDWR | O_CLOEXEC | O_NOFOLLOW, 0600);
    if (handle_ < 0)
        throw std::runtime_error("Cannot open exclusive platform publication lock.");
    if (flock(handle_, LOCK_EX | LOCK_NB) != 0) {
        close(handle_);
        handle_ = -1;
        throw std::runtime_error("Another publisher owns the platform output.");
    }
#endif
}

PlatformPublicationLock::~PlatformPublicationLock()
{
#if defined(_WIN32)
    if (handle_) {
        OVERLAPPED overlapped{};
        UnlockFileEx(static_cast<HANDLE>(handle_), 0, 1, 0, &overlapped);
        CloseHandle(static_cast<HANDLE>(handle_));
    }
#else
    if (handle_ >= 0) {
        flock(handle_, LOCK_UN);
        close(handle_);
    }
#endif
}

bool has_native_platform_publication(const fs::path& destination)
{
    return fs::exists(fs::symlink_status(journal_path(destination)));
}

bool recover_native_platform_publication(const fs::path& destination,
                                         const PlatformPublicationLock& lock, std::string& error)
{
    try {
        if (lock.destination() != destination)
            throw std::runtime_error("Publication recovery requires destination ownership.");
        recover_publication(destination);
        return true;
    } catch (const std::exception& exception) {
        error = exception.what();
        return false;
    }
}

PlatformCliResult stage_native_platform_export(
    const Json& admission, const Json& profile, const Json& descriptor,
    const fs::path& template_directory, const fs::path& icon_source, const fs::path& destination,
    bool force, bool allow_localization_warnings, bool include_unused_assets,
    bool include_shader_sources, const PlatformResolvedExportSettings& settings,
    const PlatformPublicationLock& lock, const PlatformExportTools& tools,
    const std::function<bool()>& source_current)
{
    if (lock.destination() != destination)
        return failure("WORKSPACE_TRANSACTION_RECOVERY_CONFLICT",
                       "Platform staging requires exclusive destination ownership.", 5);
    // Platform stages receive the complete resolved options; none may
    // silently downgrade a requested signed distribution to unsigned. The
    // target-specific tickets implement signing and verification here before
    // this guard is replaced for their respective targets.
    if (auto unavailable = validate_native_platform_export_settings(settings, profile))
        return *unavailable;
    if (profile.value("target", "") == "web")
        return stage_web_export(admission, profile, descriptor, template_directory, icon_source,
                                destination, force, allow_localization_warnings,
                                include_unused_assets, include_shader_sources, lock, tools,
                                source_current);
    if (profile.value("target", "") == "linux")
        return stage_linux_export(admission, profile, descriptor, template_directory, icon_source,
                                  destination, force, allow_localization_warnings,
                                  include_unused_assets, include_shader_sources, tools,
                                  source_current);
    if (profile.value("target", "") == "macos")
        return stage_macos_export(admission, profile, descriptor, template_directory, icon_source,
                                  destination, force, allow_localization_warnings,
                                  include_unused_assets, include_shader_sources, settings, tools,
                                  source_current);
    if (profile.value("target", "") == "android")
        return stage_android_export(admission, profile, descriptor, template_directory, icon_source,
                                    destination, force, allow_localization_warnings,
                                    include_unused_assets, include_shader_sources, settings, tools,
                                    source_current);
    // Only enable a platform after its complete native assembly, signing,
    // readback and publication contracts are implemented.
    if (profile.value("target", "") != "windows")
        return failure("CLI_NATIVE_CANDIDATE_UNCLAIMED",
                       "Native export staging for this target is not yet implemented.", 70);
    if (!tools.prepare_package || !tools.create_archive || !tools.resize_image ||
        !tools.physical_sources_current)
        return failure("CLI_INTERNAL", "Native platform export tools are unavailable.", 70);
    try {
        check_cancellation(tools);
        if (tools.progress)
            tools.progress("compiling-project", "Preparing the current Project runtime generation");
        if (!source_current())
            return failure("WORKSPACE_REVISION_CONFLICT", "Platform sources changed.", 5);
        const auto& app = admission.at("project").at("settings").at("app");
        const auto& desktop = profile.at("desktop");
        auto exe_name = desktop.at("executableName").get<std::string>();
        if (exe_name.size() >= 4 && exe_name.substr(exe_name.size() - 4) == ".exe")
            exe_name.resize(exe_name.size() - 4);
        if (exe_name.empty() || exe_name.starts_with('.') ||
            exe_name.find_first_of("<>:\"/\\|?*") != std::string::npos)
            return failure("platform-executable-name-invalid",
                           "Windows executable name is invalid.");
        const auto exe_target = exe_name + ".exe";
        const auto app_id = app.at("applicationId").get<std::string>();
        const auto app_name = app.at("displayName").get<std::string>();
        const auto version = app.at("versionName").get<std::string>();
        const auto save_namespace = app.at("saveNamespace").get<std::string>();
        const auto icon_source_sha = digest(read_file(icon_source));
        const auto template_descriptor_sha =
            digest(read_file(template_directory / "template.json"));
        const auto template_entry_sha =
            digest(read_file(template_directory / ".noveltea-template.json"));
        if (Json::parse(read_file(template_directory / "template.json")) != descriptor)
            return failure("platform-template-changed",
                           "Selected player template descriptor changed after preflight.", 5);

        const auto nonce = random_nonce();
        const auto archive_path = native_path_from_utf8(path_text(destination) + ".zip");
        std::vector<PublicationEntry> entries{
            {destination, native_path_from_utf8(path_text(destination) + ".stage-" + nonce),
             native_path_from_utf8(path_text(destination) + ".previous-" + nonce),
             fs::exists(fs::symlink_status(destination))},
            {archive_path, native_path_from_utf8(path_text(archive_path) + ".stage-" + nonce),
             native_path_from_utf8(path_text(archive_path) + ".previous-" + nonce),
             fs::exists(fs::symlink_status(archive_path))},
        };
        const auto with_symbols = profile.value("includeDebugSymbols", false);
        const auto symbols_output = native_path_from_utf8(path_text(destination) + "-symbols.zip");
        entries.push_back({symbols_output,
                           native_path_from_utf8(path_text(symbols_output) + ".stage-" + nonce),
                           native_path_from_utf8(path_text(symbols_output) + ".previous-" + nonce),
                           fs::exists(fs::symlink_status(symbols_output)), !with_symbols});
        for (const auto& item : entries) {
            if (fs::exists(fs::symlink_status(item.stage)) ||
                fs::exists(fs::symlink_status(item.previous)) ||
                fs::is_symlink(fs::symlink_status(item.final)) || (item.had_previous && !force))
                return failure("platform-output-exists",
                               "Platform output staging or incumbent path is unsafe.");
        }
        fs::create_directories(destination.parent_path());
        Staging cleanup(entries, journal_path(destination));
        fs::create_directory(entries[0].stage);
        const auto& stage = entries[0].stage;

        Json native_profile = admission.at("profile");
        native_profile["shaderVariants"] = Json::array({"glsl-330"});
        native_profile["localization"] = profile.at("localization");
        native_profile["excludeUnusedAssets"] =
            include_unused_assets ? false : profile.value("excludeUnusedAssets", true);
        native_profile["includeShaderSources"] =
            include_shader_sources || profile.value("includeShaderSources", false);
        native_profile["stripShaderSources"] =
            !native_profile.at("includeShaderSources").get<bool>();
        const auto package_path = stage / "game.ntpkg";
        if (tools.progress)
            tools.progress("writing-package", "Preparing and writing game.ntpkg");
        const auto packaged = tools.prepare_package(admission, native_profile, package_path);
        check_cancellation(tools);
        if (!packaged.value("ok", false))
            return failure(packaged.value("code", "native.platform.package"),
                           packaged.value("error", "Platform runtime package creation failed."),
                           packaged.value("code", "") == "WORKSPACE_REVISION_CONFLICT" ? 5 : 6);
        const auto& artifact = packaged.at("artifact");
        const auto& package_options = artifact.at("packageOptions");
        if (package_options.value("kind", "") != "runtime" || !artifact.contains("compiledProject"))
            return failure("native.runtime.artifact",
                           "Native platform preparation produced invalid package evidence.", 6);
        std::vector<Json> localization_warnings;
        for (const auto& finding : artifact.value("diagnostics", Json::array()))
            if (finding.value("severity", "") == "warning" &&
                finding.value("code", std::string{}).starts_with("localization.export."))
                localization_warnings.push_back(finding);
        if (!localization_warnings.empty() && !allow_localization_warnings)
            return failure("localization.export.warning_override_required",
                           "Localization warnings require --allow-localization-warnings.");

        std::vector<FileEntry> files;
        files.push_back(track_file(stage, "game.ntpkg", "runtime-package", "game.ntpkg", 0644));
        const auto package_sha = files.back().sha256;
        std::vector<FileEntry> symbols;
        std::set<std::string> dependency_dlls;
        std::map<std::string, std::string> dependency_origins;
        for (const auto& dependency : descriptor.at("runtimeDependencies")) {
            const auto kind = dependency.value("kind", std::string{});
            dependency_origins[dependency.at("path").get<std::string>()] =
                kind == "notice"    ? "notice"
                : kind == "library" ? "native-dependency"
                                    : "system-asset";
            if (dependency.value("kind", "") == "library") {
                const auto basename =
                    native_path_from_utf8(dependency.at("path").get<std::string>())
                        .filename()
                        .string();
                std::string lower = basename;
                std::transform(lower.begin(), lower.end(), lower.begin(),
                               [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
                dependency_dlls.insert(std::move(lower));
            }
        }
        const std::set<std::string> system_dlls{
            "advapi32.dll", "bcrypt.dll",   "comdlg32.dll", "crypt32.dll",  "d3d11.dll",
            "dbghelp.dll",  "dxgi.dll",     "gdi32.dll",    "imm32.dll",    "kernel32.dll",
            "mfplat.dll",   "ntdll.dll",    "ole32.dll",    "oleaut32.dll", "rpcrt4.dll",
            "secur32.dll",  "setupapi.dll", "shell32.dll",  "shlwapi.dll",  "user32.dll",
            "userenv.dll",  "version.dll",  "winmm.dll",    "ws2_32.dll",   "winhttp.dll"};
        if (!descriptor.contains("windowsImports"))
            return failure("platform-template-imports", "Windows template has no import list.");
        for (const auto& dll : descriptor.at("windowsImports")) {
            auto name = dll.get<std::string>();
            std::transform(name.begin(), name.end(), name.begin(),
                           [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
            if (!dependency_dlls.contains(name) && !system_dlls.contains(name) &&
                !name.starts_with("api-ms-win-") && !name.starts_with("ext-ms-win-"))
                return failure("platform-template-imports",
                               "Windows template has an unresolved import: " + name);
        }
        std::string player_path;
        const std::set<std::string> generated_names{
            "game.ntpkg",  "icons/windows/app.ico", "WINDOWS_METADATA.json",
            "player.json", "SIGNING_REPORT.json",   "export-manifest.json"};
        std::set<std::string> names;
        if (tools.progress)
            tools.progress("staging", "Staging player, package, assets and dependencies");
        for (const auto& declared : descriptor.at("files")) {
            check_cancellation(tools);
            const auto name = declared.at("path").get<std::string>();
            const auto role = declared.value("role", std::string{});
            if (!names.insert(name).second || generated_names.contains(name))
                return failure("platform-template-collision",
                               "Player template collides with a generated output: " + name);
            const auto original = safe_child(template_directory, name);
            const auto target = safe_child(stage, name);
            if (!fs::is_regular_file(fs::symlink_status(original)) ||
                fs::file_size(original) != declared.at("size").get<std::uint64_t>() ||
                digest(read_file(original)) != declared.at("sha256").get<std::string>())
                return failure("invalid-installed-template",
                               "Template source changed during export: " + name);
            copy_verified_file(original, target);
            const auto mode = declared.at("mode").get<std::uint32_t>();
            if (role == "symbol" || (name.size() >= 4 && name.substr(name.size() - 4) == ".pdb")) {
                symbols.push_back(track_file(stage, name, "template", name, mode));
                fs::remove(target);
                continue;
            }
            if (role == "player") {
                if (!player_path.empty())
                    return failure("platform-template-player", "Multiple Windows players.");
                player_path = name;
            }
            const auto origin_it = dependency_origins.find(name);
            const auto origin =
                origin_it == dependency_origins.end() ? std::string{"template"} : origin_it->second;
            const auto template_id = descriptor.at("templateId").get<std::string>();
            files.push_back(track_file(stage, name, origin, "template:" + template_id, mode));
            if (files.back().sha256 != declared.at("sha256").get<std::string>())
                return failure("invalid-installed-template",
                               "Template content changed while being copied: " + name, 5);
            if (name.starts_with("licenses/")) {
                const auto mounted = "assets/system/" + name;
                if (!names.insert(mounted).second)
                    return failure("platform-template-collision",
                                   "Template licenses collide with mounted system assets.");
                copy_verified_file(target, safe_child(stage, mounted));
                files.push_back(
                    track_file(stage, mounted, "system-asset", "template:" + template_id, mode));
            }
        }
        if (player_path.empty())
            return failure("platform-template-player", "Windows template has no player binary.");

        std::vector<std::pair<unsigned, std::string>> icon_images;
        if (tools.progress)
            tools.progress("generating-metadata", "Generating icons and platform metadata");
        for (const unsigned size : {16u, 24u, 32u, 48u, 64u, 128u, 256u}) {
            check_cancellation(tools);
            const auto temporary = stage / (".icon-" + std::to_string(size) + ".png");
            const auto resized = tools.resize_image({{"sourcePath", path_text(icon_source)},
                                                     {"outputPath", path_text(temporary)},
                                                     {"size", size}});
            if (!resized.value("ok", false))
                return failure("platform-icon-generation",
                               resized.value("error", "Native icon generation failed."));
            icon_images.emplace_back(size, read_file(temporary));
            fs::remove(temporary);
        }
        const auto icon_path = safe_child(stage, "icons/windows/app.ico");
        write_file(icon_path, make_ico(icon_images));
        files.push_back(track_file(stage, "icons/windows/app.ico", "icon", "ico", 0644));

        const auto player_target = safe_child(stage, exe_target);
        const auto original = safe_child(stage, player_path);
        if (player_target != original && fs::exists(fs::symlink_status(player_target)))
            return failure("platform-template-collision",
                           "Windows player target collides with a template file.");
        const auto executable_staged =
            native_path_from_utf8(path_text(player_target) + ".pe-" + nonce);
        customize_windows_player(original, executable_staged, icon_path,
                                 {exe_name, app_name, version, app_id});
        fs::remove(original);
        fs::rename(executable_staged, player_target);
        auto player_entry = std::find_if(files.begin(), files.end(), [&](const FileEntry& file) {
            return file.path == player_path;
        });
        if (player_entry == files.end())
            return failure("platform-template-player", "Staged player entry is missing.");
        *player_entry = track_file(stage, exe_target, "template", "template:" + player_path,
                                   player_entry->mode);
        Json signing_subjects = Json::array();
        bool signtool_timestamp_verified = false;
        if (settings.signing_requested) {
            const auto& signer = settings.signing.at("windows");
            if (!signer.is_object() || !signer.contains("command") ||
                !signer.at("command").is_string() ||
                signer.at("command").get<std::string>().empty() ||
                !signer.contains("verifyCommand") || !signer.at("verifyCommand").is_string() ||
                signer.at("verifyCommand").get<std::string>().empty() || !signer.contains("args") ||
                !signer.at("args").is_array() || !signer.contains("verifyArgs") ||
                !signer.at("verifyArgs").is_array())
                return failure("platform.signing_configuration_invalid",
                               "Windows signing configuration is incomplete.");
            for (const char* field : {"args", "verifyArgs"}) {
                const auto& arguments = signer.at(field);
                if (!std::any_of(arguments.begin(), arguments.end(), [](const Json& argument) {
                        return argument.is_string() && argument.get_ref<const std::string&>().find(
                                                           "{subject}") != std::string::npos;
                    }))
                    return failure("platform.signing_configuration_invalid",
                                   "Windows signing and verification must each identify the "
                                   "specific {subject} binary.");
            }
            if (!tools.run_signing_command)
                return failure("CLI_INTERNAL", "Native signing command executor is missing.", 70);
            std::vector<FileEntry*> signables;
            for (auto& file : files) {
                auto name = file.path;
                std::transform(name.begin(), name.end(), name.begin(), [](unsigned char ch) {
                    return static_cast<char>(std::tolower(ch));
                });
                if (name.ends_with(".exe") || name.ends_with(".dll"))
                    signables.push_back(&file);
            }
            std::sort(signables.begin(), signables.end(), [](const auto* lhs, const auto* rhs) {
                const bool a_exe = fs::path(lhs->path).extension() == ".exe";
                const bool b_exe = fs::path(rhs->path).extension() == ".exe";
                return a_exe != b_exe ? b_exe : lhs->path < rhs->path;
            });
            if (std::none_of(signables.begin(), signables.end(),
                             [&](const auto* file) { return file->path == exe_target; }))
                return failure("platform.signing_configuration_invalid",
                               "The Windows executable is not an available signing subject.");
            const auto executable = path_text(player_target);
            const auto stage_path = path_text(stage);
            const auto verifier_name =
                native_path_from_utf8(signer.at("verifyCommand").get<std::string>())
                    .filename()
                    .string();
            const auto is_signtool = verifier_name == "signtool" ||
                                     verifier_name == "signtool.exe" ||
                                     verifier_name == "SignTool.exe";
            const auto& verifier_args = signer.at("verifyArgs");
            signtool_timestamp_verified =
                is_signtool &&
                std::any_of(verifier_args.begin(), verifier_args.end(), [](const Json& arg) {
                    return arg.is_string() &&
                           (arg.get<std::string>() == "/tw" || arg.get<std::string>() == "/TW");
                });
            for (auto* file : signables) {
                check_cancellation(tools);
                const auto subject = path_text(safe_child(stage, file->path));
                const auto expand = [&](const Json& configured) {
                    std::vector<std::string> arguments;
                    for (const auto& argument : configured) {
                        if (!argument.is_string())
                            throw std::runtime_error("Invalid Windows signing argument.");
                        auto value = argument.get<std::string>();
                        for (const auto& [token, replacement] :
                             std::array<std::pair<std::string_view, std::string_view>, 3>{
                                 {{"{subject}", subject},
                                  {"{executable}", executable},
                                  {"{stage}", stage_path}}}) {
                            std::size_t position = 0;
                            while ((position = value.find(token, position)) != std::string::npos) {
                                value.replace(position, token.size(), replacement);
                                position += replacement.size();
                            }
                        }
                        arguments.push_back(std::move(value));
                    }
                    return arguments;
                };
                if (tools.progress)
                    tools.progress("signing",
                                   "Signing and verifying Windows distribution binaries");
                if (!tools.run_signing_command(signer.at("command").get<std::string>(),
                                               expand(signer.at("args")), stage))
                    return failure("platform.signing_failed",
                                   "The configured Windows signing command failed.");
                check_cancellation(tools);
                if (!tools.run_signing_command(signer.at("verifyCommand").get<std::string>(),
                                               expand(signer.at("verifyArgs")), stage))
                    return failure("platform.signature_verification_failed",
                                   "Independent verification of a signed Windows binary failed.");
                *file = track_file(stage, file->path, file->origin, file->origin_id, file->mode);
                signing_subjects.push_back({{"path", file->path}, {"sha256", file->sha256}});
            }
        }
        write_file(stage / "WINDOWS_METADATA.json",
                   Json{{"applicationId", app_id},
                        {"executable", exe_target},
                        {"buildId", descriptor.at("buildId")},
                        {"resourceMutationComplete", true},
                        {"signingBoundary",
                         "No executable or DLL mutation is permitted after this point."},
                        {"signingCommandHook",
                         {{"supported", true}, {"configured", settings.signing_requested}}}}
                           .dump(2) +
                       '\n');
        files.push_back(track_file(stage, "WINDOWS_METADATA.json", "generated-metadata",
                                   "windows-metadata", 0644));
        if (settings.signing_requested) {
            write_file(
                stage / "SIGNING_REPORT.json",
                Json{{"format", "noveltea.signing-report"},
                     {"platform", "windows"},
                     {"templateBuildId", descriptor.at("buildId")},
                     {"gamePackageSha256", package_sha},
                     {"signed", true},
                     {"verified", true},
                     {"timestamped", signtool_timestamp_verified ? Json(true) : Json(nullptr)},
                     {"subjects", signing_subjects}}
                        .dump(2) +
                    '\n');
            files.push_back(track_file(stage, "SIGNING_REPORT.json", "signing-report",
                                       "windows-signing", 0644));
        }

        // Asset-memory policy values must match the public platform contract.
        // A custom policy is blocked until native policy resolution is ported.
        const auto& memory = profile.at("assetMemory");
        if (memory.value("kind", "") != "builtin")
            return failure("platform-asset-memory-policy",
                           "Native Windows export does not yet support custom memory policies.",
                           70);
        const auto preset = memory.at("preset").get<std::string>();
        const std::map<std::string, std::array<std::uint64_t, 7>> baselines{
            {"low", {67108864, 671088640, 33554432, 33554432, 13421772, 536870912, 6710886}},
            {"balanced",
             {134217728, 1342177280, 67108864, 67108864, 40265318, 1073741824, 20132659}},
            {"high",
             {268435456, 2684354560, 134217728, 134217728, 107374182, 2147483648, 53687091}}};
        if (!baselines.contains(preset))
            return failure("platform-asset-memory-policy", "Unknown asset-memory preset.");
        const auto& values = baselines.at(preset);
        const Json asset_memory{{"preset", preset},
                                {"preparedCpuBytes", values[0]},
                                {"gpuBytes", values[1]},
                                {"audioBytes", values[2]},
                                {"temporaryBytes", values[3]},
                                {"warmPreparedCpuBytes", values[4]},
                                {"warmGpuBytes", values[5]},
                                {"warmAudioBytes", values[6]}};
        const auto raw_display = package_options.at("display");
        const auto raw_accessibility = package_options.at("accessibility");
        Json display{{"referenceResolution", raw_display.at("reference_resolution")},
                     {"worldRasterPolicy", raw_display.at("world_raster_policy")},
                     {"barColor", raw_display.at("bar_color")}};
        Json accessibility{{"uiScale", raw_accessibility.at("ui_scale")},
                           {"textScale", raw_accessibility.at("text_scale")}};
        Json player{{"format", "noveltea.player-config"},
                    {"formatVersion", 1},
                    {"displayName", app_name},
                    {"applicationId", app_id},
                    {"saveNamespace", save_namespace},
                    {"versionName", version},
                    {"package", {{"path", "game.ntpkg"}, {"sha256", package_sha}}},
                    {"capabilities", Json::array({"external-url"})},
                    {"display", display},
                    {"accessibility", accessibility},
                    {"assetMemory", asset_memory}};
        if (app.contains("defaultLocale") && app.at("defaultLocale").is_string())
            player["defaultLocale"] = app.at("defaultLocale");
        write_file(stage / "player.json", player.dump(2) + '\n');
        files.push_back(
            track_file(stage, "player.json", "generated-metadata", "player-config", 0644));
        const auto& resolution = display.at("referenceResolution");
        const auto width = resolution.at("width").get<int>();
        const auto height = resolution.at("height").get<int>();
        if (width <= 0 || height <= 0)
            return failure("platform-runtime-display", "Platform display resolution is invalid.");
        const auto divisor = std::gcd(width, height);
        Json geometry{{"aspectRatio", {{"width", width / divisor}, {"height", height / divisor}}},
                      {"orientation", width >= height ? "landscape" : "portrait"},
                      {"barColor", display.at("barColor")}};
        Json deployment{{"target", "windows"},
                        {"architecture", profile.at("architecture")},
                        {"buildFlavor", profile.at("buildFlavor")},
                        {"applicationId", app_id},
                        {"displayName", app_name},
                        {"versionName", version},
                        {"saveNamespace", save_namespace},
                        {"capabilities", Json::array({"external-url"})},
                        {"capabilityMetadata",
                         {{"androidPermissions", Json::array()},
                          {"androidFeatures", Json::array()},
                          {"webRequirements", Json::array()},
                          {"desktopFeatures", Json::array()}}},
                        {"display", geometry},
                        {"packageAccess", profile.at("packageAccess")},
                        {"templateId", descriptor.at("templateId")},
                        {"buildId", descriptor.at("buildId")},
                        {"compiledProjectFormatVersion", 1},
                        {"playerRuntimeApiVersion", 1},
                        {"assetMemory", asset_memory}};
        Json file_inventory = Json::array();
        std::sort(files.begin(), files.end(),
                  [](const FileEntry& a, const FileEntry& b) { return a.path < b.path; });
        for (const auto& file : files)
            file_inventory.push_back(file.json());
        const Json manifest{{"format", "noveltea.platform-export-manifest"},
                            {"deployment", deployment},
                            {"files", file_inventory}};
        write_file(stage / "export-manifest.json", manifest.dump(2) + '\n');
        files.push_back(track_file(stage, "export-manifest.json", "generated-metadata",
                                   "export-manifest", 0644));
        Json archive_entries = Json::array();
        for (const auto& file : files)
            archive_entries.push_back({{"sourcePath", path_text(safe_child(stage, file.path))},
                                       {"archivePath", file.path},
                                       {"size", file.size},
                                       {"mode", file.mode}});
        if (tools.progress)
            tools.progress("finalizing", "Finalizing distribution archives");
        const auto archived =
            tools.create_archive({{"outputPath", path_text(entries[1].stage)},
                                  {"format", "zip"},
                                  {"compression", profile.value("compression", "default")},
                                  {"entries", archive_entries}});
        check_cancellation(tools);
        if (!archived.value("ok", false))
            return failure("platform-archive-failed",
                           archived.value("error", "Windows distribution archive failed."));
        std::optional<std::string> symbols_archive_sha;
        if (with_symbols) {
            const auto symbol_stage = stage / ".symbol-build";
            fs::create_directory(symbol_stage);
            Json symbol_entries = Json::array();
            std::vector<FileEntry> symbol_files;
            for (const auto& file : symbols) {
                check_cancellation(tools);
                const auto name = native_path_from_utf8(file.path).filename().string();
                const auto copy = symbol_stage / native_path_from_utf8(name);
                copy_verified_file(safe_child(template_directory, file.path), copy);
                symbol_files.push_back(track_file(symbol_stage, name, "symbol", name, file.mode));
                symbol_entries.push_back({{"sourcePath", path_text(copy)},
                                          {"archivePath", name},
                                          {"size", file.size},
                                          {"mode", file.mode}});
            }
            write_file(symbol_stage / "BUILD_ID",
                       descriptor.at("buildId").get<std::string>() + '\n');
            symbol_files.push_back(
                track_file(symbol_stage, "BUILD_ID", "generated-metadata", "build-id", 0644));
            symbol_entries.push_back({{"sourcePath", path_text(symbol_stage / "BUILD_ID")},
                                      {"archivePath", "BUILD_ID"},
                                      {"size", fs::file_size(symbol_stage / "BUILD_ID")},
                                      {"mode", 0644}});
            const auto packed_symbols =
                tools.create_archive({{"outputPath", path_text(entries[2].stage)},
                                      {"format", "zip"},
                                      {"compression", profile.value("compression", "default")},
                                      {"entries", symbol_entries}});
            check_cancellation(tools);
            if (!packed_symbols.value("ok", false))
                return failure("platform-archive-failed",
                               packed_symbols.value("error", "Windows symbols archive failed."));
            verify_archive(entries[2].stage, symbol_stage, symbol_files);
            symbols_archive_sha = digest(read_file(entries[2].stage));
            fs::remove_all(symbol_stage);
        }
        // Do not publish an obsolete Project or changed template/Icon bytes.
        // Template files are checked again separately from Project generation.
        if (tools.progress)
            tools.progress("verifying", "Verifying source freshness and published artifacts");
        check_cancellation(tools);
        if (!source_current() || !tools.physical_sources_current(package_options) ||
            digest(read_file(icon_source)) != icon_source_sha)
            return failure("WORKSPACE_REVISION_CONFLICT",
                           "Platform export source changed before activation.", 5);
        if (digest(read_file(template_directory / "template.json")) != template_descriptor_sha ||
            digest(read_file(template_directory / ".noveltea-template.json")) != template_entry_sha)
            return failure("platform-template-changed",
                           "Player template registry metadata changed during export.", 5);
        for (const auto& item : descriptor.at("files")) {
            const auto original =
                safe_child(template_directory, item.at("path").get<std::string>());
            if (!fs::is_regular_file(fs::symlink_status(original)) ||
                digest(read_file(original)) != item.at("sha256").get<std::string>())
                return failure("platform-template-changed",
                               "Player template changed before output activation.", 5);
        }
        publish(destination, entries, nonce, [&]() {
            check_cancellation(tools);
            verify_distribution(destination, archive_path, files);
            if (symbols_archive_sha && digest(read_file(entries[2].final)) != *symbols_archive_sha)
                throw std::runtime_error("Published symbols archive changed after verification.");
            check_cancellation(tools);
            if (!source_current() || !tools.physical_sources_current(package_options) ||
                digest(read_file(icon_source)) != icon_source_sha)
                throw SourceChanged("Platform export inputs changed during publication.");
            if (digest(read_file(template_directory / "template.json")) !=
                    template_descriptor_sha ||
                digest(read_file(template_directory / ".noveltea-template.json")) !=
                    template_entry_sha)
                throw SourceChanged(
                    "Player template registry metadata changed during publication.");
            for (const auto& item : descriptor.at("files")) {
                const auto original =
                    safe_child(template_directory, item.at("path").get<std::string>());
                if (!fs::is_regular_file(fs::symlink_status(original)) ||
                    digest(read_file(original)) != item.at("sha256").get<std::string>())
                    throw SourceChanged("Player template changed during publication.");
            }
            check_cancellation(tools);
        });
        Json artifacts = Json::array({{{"kind", "directory"}, {"path", path_text(destination)}},
                                      {{"kind", "archive"},
                                       {"path", path_text(archive_path)},
                                       {"size", fs::file_size(archive_path)}}});
        Json envelope{{"success", true},
                      {"exitCode", 0},
                      {"diagnostics", Json::array()},
                      {"outputDirectory", path_text(destination)},
                      {"archivePath", path_text(archive_path)},
                      {"templateToken", descriptor.at("templateId").get<std::string>() + "@" +
                                            descriptor.at("buildId").get<std::string>()},
                      {"signingRequested", settings.signing_requested},
                      {"signingApplied", settings.signing_requested},
                      {"cancelled", false},
                      {"artifacts", std::move(artifacts)},
                      {"deployment", deployment}};
        if (with_symbols) {
            const auto symbols_path =
                native_path_from_utf8(path_text(destination) + "-symbols.zip");
            envelope["symbolArchivePath"] = path_text(symbols_path);
        }
        return {std::move(envelope), "Native Windows platform export succeeded."};
    } catch (const ExportCancelled& error) {
        auto cancelled = failure("export-cancelled", error.what(), 130);
        cancelled.envelope["cancelled"] = true;
        return cancelled;
    } catch (const SourceChanged& error) {
        return failure("WORKSPACE_REVISION_CONFLICT", error.what(), 5);
    } catch (const std::exception& error) {
        return failure("platform-staging-failed", error.what());
    }
}

} // namespace noveltea::cli
