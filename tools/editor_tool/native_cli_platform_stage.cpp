#include "native_cli_platform_stage.hpp"

#include "native_cli_web_shell.hpp"
#include "native_cli_windows_pe.hpp"

#include <noveltea/core/player_bootstrap.hpp>
#include <miniz/miniz.h>

#include <algorithm>
#include <array>
#include <chrono>
#include <cctype>
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
    const auto temporary = fs::u8path(path_text(destination) + ".new-" + std::string(nonce));
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
        result /= fs::u8path(part);
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
    return fs::u8path(path_text(destination) + ".noveltea-publication-transaction.json");
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
            (kind != "directory" && kind != "archive" && kind != "symbols"))
            throw std::runtime_error("Invalid platform publication journal output kind.");
        const auto base = path_text(destination);
        const auto final = kind == "directory" ? destination
                           : kind == "archive" ? fs::u8path(base + ".zip")
                                               : fs::u8path(base + "-symbols.zip");
        if (kind != "symbols" && item.at("removeOnly").get<bool>())
            throw std::runtime_error("Cannot retire required platform artifact.");
        entries.push_back({final, fs::u8path(path_text(final) + ".stage-" + nonce),
                           fs::u8path(path_text(final) + ".previous-" + nonce),
                           item.at("hadPrevious").get<bool>(), item.at("removeOnly").get<bool>()});
    }
    if (kinds.size() < 2 || !kinds.contains("directory") || !kinds.contains("archive"))
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
    const auto orphan =
        fs::u8path(path_text(journal_file) + ".new-" + journal.at("nonce").get<std::string>());
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
        const std::string kind = entry.final == destination                         ? "directory"
                                 : path_text(entry.final).ends_with("-symbols.zip") ? "symbols"
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
                    const std::vector<FileEntry>& files)
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
        if (!actual.contains(file.path) || actual.at(file.path).second != file.size)
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
            mz_zip_reader_extract_iter_new(&reader.archive, actual.at(file.path).first, 0);
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
        const auto archive_path = fs::u8path(path_text(destination) + ".zip");
        const std::vector<PublicationEntry> entries{
            {destination, fs::u8path(path_text(destination) + ".stage-" + nonce),
             fs::u8path(path_text(destination) + ".previous-" + nonce),
             fs::exists(fs::symlink_status(destination))},
            {archive_path, fs::u8path(path_text(archive_path) + ".stage-" + nonce),
             fs::u8path(path_text(archive_path) + ".previous-" + nonce),
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
                       path_text(fs::u8path(file.path).filename()) == runtime_names[index];
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
        unavailable.envelope["diagnostics"][0]["path"] = "/signingProfile";
        return unavailable;
    }
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
    const auto lock_file = fs::u8path(path_text(destination_) + ".noveltea-publication.lock");
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
        const auto archive_path = fs::u8path(path_text(destination) + ".zip");
        std::vector<PublicationEntry> entries{
            {destination, fs::u8path(path_text(destination) + ".stage-" + nonce),
             fs::u8path(path_text(destination) + ".previous-" + nonce),
             fs::exists(fs::symlink_status(destination))},
            {archive_path, fs::u8path(path_text(archive_path) + ".stage-" + nonce),
             fs::u8path(path_text(archive_path) + ".previous-" + nonce),
             fs::exists(fs::symlink_status(archive_path))},
        };
        const auto with_symbols = profile.value("includeDebugSymbols", false);
        const auto symbols_output = fs::u8path(path_text(destination) + "-symbols.zip");
        entries.push_back({symbols_output,
                           fs::u8path(path_text(symbols_output) + ".stage-" + nonce),
                           fs::u8path(path_text(symbols_output) + ".previous-" + nonce),
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
                    fs::u8path(dependency.at("path").get<std::string>()).filename().string();
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
        const auto executable_staged = fs::u8path(path_text(player_target) + ".pe-" + nonce);
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
                fs::u8path(signer.at("verifyCommand").get<std::string>()).filename().string();
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
                const auto name = fs::u8path(file.path).filename().string();
                const auto copy = symbol_stage / fs::u8path(name);
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
            const auto symbols_path = fs::u8path(path_text(destination) + "-symbols.zip");
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
