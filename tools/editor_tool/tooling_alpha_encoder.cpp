#include "tooling_native_c.h"

#include <bimg/bimg.h>
#include <bimg/decode.h>
#include <bx/allocator.h>
#include <nlohmann/json.hpp>

#include <algorithm>
#include <array>
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <limits>
#include <mutex>
#include <stdexcept>
#include <string>
#include <string_view>
#include <thread>
#include <utility>
#include <vector>

#if defined(_WIN32)
#include <windows.h>
#else
#include <cerrno>
#include <csignal>
#include <spawn.h>
#if defined(__linux__)
#include <sys/prctl.h>
#endif
#include <sys/wait.h>
#include <unistd.h>
extern char** environ;
#endif

namespace {

using Bytes = std::vector<std::uint8_t>;
using Json = nlohmann::json;
constexpr std::size_t max_webp_bytes = 128u * 1024u * 1024u;
constexpr std::size_t max_diagnostics = 24u * 1024u * 1024u;
constexpr std::uint32_t max_hold_ms = 0xffffff;
constexpr std::size_t max_frames = 65536;
constexpr auto child_timeout = std::chrono::minutes(15);

void ensure(bool condition, const char* message)
{
    if (!condition)
        throw std::runtime_error(message);
}
std::uint32_t le32(const std::uint8_t* ptr)
{
    return static_cast<std::uint32_t>(ptr[0]) | (static_cast<std::uint32_t>(ptr[1]) << 8) |
           (static_cast<std::uint32_t>(ptr[2]) << 16) | (static_cast<std::uint32_t>(ptr[3]) << 24);
}
void u32(Bytes& out, std::uint32_t value)
{
    for (int shift = 0; shift < 32; shift += 8)
        out.push_back(static_cast<std::uint8_t>(value >> shift));
}
void u24(Bytes& out, std::uint32_t value)
{
    ensure(value <= max_hold_ms, "WebP 24-bit field exceeded.");
    for (int shift = 0; shift < 24; shift += 8)
        out.push_back(static_cast<std::uint8_t>(value >> shift));
}
void append(Bytes& out, const char* text, std::size_t size)
{
    out.insert(out.end(), text, text + size);
}
void chunk(Bytes& out, const char tag[5], const Bytes& payload)
{
    append(out, tag, 4);
    u32(out, static_cast<std::uint32_t>(payload.size()));
    out.insert(out.end(), payload.begin(), payload.end());
    if (payload.size() & 1u)
        out.push_back(0);
}
#if defined(_WIN32)
std::wstring wide(std::string_view input)
{
    const auto count = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, input.data(),
                                           static_cast<int>(input.size()), nullptr, 0);
    ensure(count > 0, "Invalid UTF-8 FFmpeg process path or argument.");
    std::wstring result(static_cast<std::size_t>(count), L'\0');
    ensure(MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, input.data(),
                               static_cast<int>(input.size()), result.data(), count) == count,
           "Cannot convert FFmpeg argument to UTF-16.");
    return result;
}
std::wstring quote(std::wstring_view arg)
{
    std::wstring result = L"\"";
    std::size_t slashes = 0;
    for (wchar_t c : arg) {
        if (c == L'\\') {
            ++slashes;
        } else if (c == L'"') {
            result.append(slashes * 2 + 1, L'\\');
            result.push_back(c);
            slashes = 0;
        } else {
            result.append(slashes, L'\\');
            result.push_back(c);
            slashes = 0;
        }
    }
    result.append(slashes * 2, L'\\');
    result.push_back(L'"');
    return result;
}
#endif

// Owns subprocess lifetime and both read pipes. Stdout is consumed by the
// caller; a separate thread drains diagnostics to prevent pipe deadlock.
// The watchdog and destructor terminate abandoned or timed-out subprocesses.
class FfmpegProcess {
public:
    FfmpegProcess(const std::string& executable, const std::vector<std::string>& arguments)
    {
#if defined(_WIN32)
        SECURITY_ATTRIBUTES security{sizeof(SECURITY_ATTRIBUTES), nullptr, TRUE};
        HANDLE stdout_write = nullptr;
        HANDLE stderr_write = nullptr;
        if (!CreatePipe(&out_, &stdout_write, &security, 0))
            throw std::runtime_error("Cannot create FFmpeg stdout pipe.");
        if (!SetHandleInformation(out_, HANDLE_FLAG_INHERIT, 0) ||
            !CreatePipe(&err_, &stderr_write, &security, 0) ||
            !SetHandleInformation(err_, HANDLE_FLAG_INHERIT, 0)) {
            if (stdout_write)
                CloseHandle(stdout_write);
            if (stderr_write)
                CloseHandle(stderr_write);
            if (out_)
                CloseHandle(out_);
            if (err_)
                CloseHandle(err_);
            throw std::runtime_error("Cannot create FFmpeg stderr pipe.");
        }
        STARTUPINFOW startup{};
        startup.cb = sizeof(startup);
        startup.dwFlags = STARTF_USESTDHANDLES;
        startup.hStdInput = GetStdHandle(STD_INPUT_HANDLE);
        startup.hStdOutput = stdout_write;
        startup.hStdError = stderr_write;
        auto program = wide(executable);
        std::wstring command = quote(program);
        for (const auto& argument : arguments) {
            command += L' ';
            command += quote(wide(argument));
        }
        PROCESS_INFORMATION child{};
        const bool created =
            CreateProcessW(program.c_str(), command.data(), nullptr, nullptr, TRUE,
                           CREATE_NO_WINDOW, nullptr, nullptr, &startup, &child) != FALSE;
        CloseHandle(stdout_write);
        CloseHandle(stderr_write);
        if (!created) {
            CloseHandle(out_);
            CloseHandle(err_);
            throw std::runtime_error("Cannot launch the configured FFmpeg executable.");
        }
        process_ = child.hProcess;
        CloseHandle(child.hThread);
        job_ = CreateJobObjectW(nullptr, nullptr);
        if (job_) {
            JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if (!SetInformationJobObject(job_, JobObjectExtendedLimitInformation, &limits,
                                         sizeof(limits)) ||
                !AssignProcessToJobObject(job_, process_)) {
                CloseHandle(job_);
                job_ = nullptr;
            }
        }
#else
        int out_pipe[2]{-1, -1};
        int err_pipe[2]{-1, -1};
        if (::pipe(out_pipe) || ::pipe(err_pipe)) {
            for (int fd : out_pipe)
                if (fd >= 0)
                    ::close(fd);
            for (int fd : err_pipe)
                if (fd >= 0)
                    ::close(fd);
            throw std::runtime_error("Cannot create FFmpeg process pipes.");
        }
        std::vector<char*> argv;
        argv.push_back(const_cast<char*>(executable.c_str()));
        for (const auto& argument : arguments)
            argv.push_back(const_cast<char*>(argument.c_str()));
        argv.push_back(nullptr);
#if defined(__linux__)
        // A ScriptC disposable worker can be killed without unwinding C++.
        // PDEATHSIG prevents FFmpeg escaping as an orphan in that case.
        const auto parent = ::getpid();
        pid_ = ::fork();
        const int spawned = pid_ < 0 ? errno : 0;
        if (pid_ == 0) {
            ::setpgid(0, 0);
            (void)::prctl(PR_SET_PDEATHSIG, SIGKILL);
            if (::getppid() != parent)
                ::_exit(127);
            (void)::dup2(out_pipe[1], STDOUT_FILENO);
            (void)::dup2(err_pipe[1], STDERR_FILENO);
            for (int fd : out_pipe)
                ::close(fd);
            for (int fd : err_pipe)
                ::close(fd);
            ::execv(executable.c_str(), argv.data());
            ::_exit(127);
        }
#else
        posix_spawn_file_actions_t actions{};
        posix_spawn_file_actions_init(&actions);
        posix_spawn_file_actions_adddup2(&actions, out_pipe[1], STDOUT_FILENO);
        posix_spawn_file_actions_adddup2(&actions, err_pipe[1], STDERR_FILENO);
        for (int fd : out_pipe)
            posix_spawn_file_actions_addclose(&actions, fd);
        for (int fd : err_pipe)
            posix_spawn_file_actions_addclose(&actions, fd);
        posix_spawnattr_t attributes{};
        posix_spawnattr_init(&attributes);
        posix_spawnattr_setflags(&attributes, POSIX_SPAWN_SETPGROUP);
        posix_spawnattr_setpgroup(&attributes, 0);
        const int spawned =
            posix_spawnp(&pid_, executable.c_str(), &actions, &attributes, argv.data(), environ);
        posix_spawnattr_destroy(&attributes);
        posix_spawn_file_actions_destroy(&actions);
#endif
        ::close(out_pipe[1]);
        ::close(err_pipe[1]);
        if (spawned != 0) {
            ::close(out_pipe[0]);
            ::close(err_pipe[0]);
            throw std::runtime_error("Cannot launch the configured FFmpeg executable.");
        }
        out_ = out_pipe[0];
        err_ = err_pipe[0];
#endif
        try {
            stderr_thread_ = std::thread([this] { drain_stderr(); });
            watchdog_ = std::thread([this] {
                std::unique_lock lock(watch_mutex_);
                if (!watch_cv_.wait_for(lock, child_timeout, [this] { return finished_.load(); })) {
                    timed_out_.store(true);
                    terminate();
                }
            });
        } catch (...) {
            terminate();
            close_pipes();
            if (stderr_thread_.joinable())
                stderr_thread_.join();
            if (watchdog_.joinable())
                watchdog_.join();
            reap();
            throw;
        }
    }

    FfmpegProcess(const FfmpegProcess&) = delete;
    FfmpegProcess& operator=(const FfmpegProcess&) = delete;

    ~FfmpegProcess()
    {
        if (!reaped_)
            terminate();
        finished_.store(true);
        watch_cv_.notify_all();
        reap();
        close_pipes();
        if (stderr_thread_.joinable())
            stderr_thread_.join();
        if (watchdog_.joinable())
            watchdog_.join();
#if defined(_WIN32)
        if (job_)
            CloseHandle(job_);
        if (process_)
            CloseHandle(process_);
#endif
    }

    std::size_t read(std::uint8_t* buffer, std::size_t size)
    {
#if defined(_WIN32)
        DWORD received = 0;
        if (!ReadFile(out_, buffer, static_cast<DWORD>(std::min<std::size_t>(size, 1024 * 1024)),
                      &received, nullptr)) {
            if (GetLastError() == ERROR_BROKEN_PIPE)
                return 0;
            throw std::runtime_error("Reading FFmpeg WebP output failed.");
        }
        return received;
#else
        for (;;) {
            const auto read_count = ::read(out_, buffer, size);
            if (read_count >= 0)
                return static_cast<std::size_t>(read_count);
            if (errno != EINTR)
                throw std::runtime_error("Reading FFmpeg WebP output failed.");
        }
#endif
    }

    std::string finish()
    {
        reap();
        finished_.store(true);
        watch_cv_.notify_all();
        if (stderr_thread_.joinable())
            stderr_thread_.join();
        ensure(!timed_out_.load(), "FFmpeg alpha preparation timed out.");
        ensure(!log_overflow_.load(), "FFmpeg alpha diagnostics exceeded the configured limit.");
        if (exit_code_ != 0)
            throw std::runtime_error("FFmpeg alpha encoder exited unsuccessfully: " +
                                     diagnostics_.substr(0, 4096));
        return diagnostics_;
    }

private:
    void drain_stderr()
    {
        std::array<char, 8192> buffer{};
        for (;;) {
#if defined(_WIN32)
            DWORD received = 0;
            if (!ReadFile(err_, buffer.data(), static_cast<DWORD>(buffer.size()), &received,
                          nullptr) ||
                received == 0)
                break;
            const std::size_t count = received;
#else
            const auto received = ::read(err_, buffer.data(), buffer.size());
            if (received == 0)
                break;
            if (received < 0) {
                if (errno == EINTR)
                    continue;
                break;
            }
            const std::size_t count = static_cast<std::size_t>(received);
#endif
            if (diagnostics_.size() + count > max_diagnostics) {
                log_overflow_.store(true);
                terminate();
                break;
            }
            diagnostics_.append(buffer.data(), count);
        }
    }

    void terminate()
    {
#if defined(_WIN32)
        if (process_)
            TerminateProcess(process_, 1);
#else
        if (pid_ > 0) {
            // The child may not have entered its process group yet. Kill both
            // the group (if formed) and the specific child, even on early errors.
            (void)::kill(-pid_, SIGKILL);
            (void)::kill(pid_, SIGKILL);
        }
#endif
    }

    void reap()
    {
        if (reaped_)
            return;
#if defined(_WIN32)
        if (process_) {
            WaitForSingleObject(process_, INFINITE);
            DWORD code = 1;
            if (GetExitCodeProcess(process_, &code))
                exit_code_ = static_cast<int>(code);
        }
#else
        if (pid_ > 0) {
            int status = 0;
            while (::waitpid(pid_, &status, 0) < 0) {
                if (errno != EINTR)
                    break;
            }
            if (WIFEXITED(status))
                exit_code_ = WEXITSTATUS(status);
        }
#endif
        reaped_ = true;
    }
    void close_pipes()
    {
#if defined(_WIN32)
        if (out_) {
            CloseHandle(out_);
            out_ = nullptr;
        }
        if (err_) {
            CloseHandle(err_);
            err_ = nullptr;
        }
#else
        if (out_ >= 0) {
            ::close(out_);
            out_ = -1;
        }
        if (err_ >= 0) {
            ::close(err_);
            err_ = -1;
        }
#endif
    }

#if defined(_WIN32)
    HANDLE process_ = nullptr, job_ = nullptr, out_ = nullptr, err_ = nullptr;
#else
    pid_t pid_ = -1;
    int out_ = -1, err_ = -1;
#endif
    std::thread stderr_thread_, watchdog_;
    std::mutex watch_mutex_;
    std::condition_variable watch_cv_;
    std::atomic<bool> finished_{false}, timed_out_{false}, log_overflow_{false};
    std::string diagnostics_;
    bool reaped_ = false;
    int exit_code_ = -1;
};

bool read_exact(FfmpegProcess& process, std::uint8_t* buffer, std::size_t size,
                bool allow_eof = false)
{
    std::size_t at = 0;
    while (at < size) {
        const auto count = process.read(buffer + at, size - at);
        if (count == 0) {
            ensure(at == 0 && allow_eof, "FFmpeg ended in the middle of a WebP page.");
            return false;
        }
        at += count;
    }
    return true;
}

bool has_nonopaque_alpha(const Bytes& payload, std::uint32_t width, std::uint32_t height)
{
    Bytes riff;
    append(riff, "RIFF", 4);
    u32(riff, static_cast<std::uint32_t>(payload.size() + 4));
    append(riff, "WEBP", 4);
    riff.insert(riff.end(), payload.begin(), payload.end());
    bx::DefaultAllocator allocator;
    auto* image = bimg::imageParse(&allocator, riff.data(), static_cast<std::uint32_t>(riff.size()),
                                   bimg::TextureFormat::RGBA8);
    ensure(image != nullptr, "FFmpeg VP8L output failed the native WebP decoder.");
    bimg::ImageMip mip{};
    const bool valid = image->m_width == width && image->m_height == height &&
                       bimg::imageGetRawData(*image, 0, 0, image->m_data, image->m_size, mip) &&
                       mip.m_format == bimg::TextureFormat::RGBA8;
    bool visible = false;
    if (valid) {
        const auto* bytes = static_cast<const std::uint8_t*>(mip.m_data);
        for (std::size_t at = 3; at < static_cast<std::size_t>(width) * height * 4; at += 4) {
            if (bytes[at] != 255) {
                visible = true;
                break;
            }
        }
    }
    bimg::imageFree(image);
    ensure(valid, "Decoded WebP page has incorrect dimensions or format.");
    return visible;
}

struct Hold {
    std::uint64_t start = 0;
    std::uint64_t duration = 0;
};
Bytes build_webp(const std::vector<Bytes>& pages, const std::vector<Hold>& holds,
                 std::uint32_t width, std::uint32_t height)
{
    Bytes webp;
    append(webp, "RIFF", 4);
    u32(webp, 0);
    append(webp, "WEBP", 4);
    if (pages.size() == 1) {
        webp.insert(webp.end(), pages[0].begin(), pages[0].end());
    } else {
        Bytes header{0x12, 0, 0, 0};
        u24(header, width - 1);
        u24(header, height - 1);
        chunk(webp, "VP8X", header);
        chunk(webp, "ANIM", Bytes(6, 0));
        for (std::size_t index = 0; index < pages.size(); ++index) {
            ensure(holds[index].duration <= max_hold_ms, "Animated WebP hold exceeds 24 bits.");
            Bytes payload;
            u24(payload, 0);
            u24(payload, 0);
            u24(payload, width - 1);
            u24(payload, height - 1);
            u24(payload, static_cast<std::uint32_t>(holds[index].duration));
            payload.push_back(2);
            payload.insert(payload.end(), pages[index].begin(), pages[index].end());
            chunk(webp, "ANMF", payload);
            ensure(webp.size() <= max_webp_bytes, "Compressed alpha WebP exceeds 128 MiB.");
        }
    }
    ensure(webp.size() <= max_webp_bytes, "Compressed alpha WebP exceeds 128 MiB.");
    const auto riff_size = static_cast<std::uint32_t>(webp.size() - 8);
    for (int shift = 0; shift < 32; shift += 8)
        webp[4 + shift / 8] = static_cast<std::uint8_t>(riff_size >> shift);
    return webp;
}

Json encode(const Json& request)
{
    ensure(request.is_object(), "Native alpha request must be an object.");
    const auto executable = request.at("executable").get<std::string>();
    const auto arguments = request.at("arguments").get<std::vector<std::string>>();
    const auto durations = request.at("durationsMs").get<std::vector<std::uint64_t>>();
    const auto width = request.at("width").get<std::uint32_t>();
    const auto height = request.at("height").get<std::uint32_t>();
    const auto output_path = request.at("outputPath").get<std::string>();
    ensure(!executable.empty() && !output_path.empty() && !arguments.empty(),
           "Native alpha encoder needs FFmpeg, output path and arguments.");
    const auto executable_path =
#if defined(_WIN32)
        std::filesystem::path(wide(executable));
#else
        std::filesystem::path(executable);
#endif
    ensure(executable_path.is_absolute() && std::filesystem::is_regular_file(executable_path),
           "Cannot launch the configured FFmpeg executable.");
    ensure(width > 0 && height > 0 && width <= 16384 && height <= 16384 &&
               static_cast<std::uint64_t>(width) * height <= 16ull * 1024ull * 1024ull,
           "Native alpha encoder canvas is invalid.");
    ensure(!durations.empty() && durations.size() <= max_frames,
           "Native alpha encoder exceeds its frame budget.");
    ensure(arguments.back() == "pipe:1", "Native alpha encoder requires piped WebP output.");
    std::uint64_t expected_endpoint = 0;
    for (const auto duration : durations) {
        ensure(duration > 0, "Native alpha frame duration is invalid or unrepresentable.");
        ensure(expected_endpoint <= (std::numeric_limits<std::uint64_t>::max)() - duration,
               "Native alpha timeline overflow.");
        expected_endpoint += duration;
    }

    FfmpegProcess process(executable, arguments);
    std::vector<Bytes> pages;
    std::vector<Hold> holds;
    Bytes previous;
    std::uint64_t elapsed = 0;
    std::size_t consumed = 0;
    std::size_t compressed_size = 12;
    bool has_transparency = false;
    for (;;) {
        std::array<std::uint8_t, 12> header{};
        if (!read_exact(process, header.data(), header.size(), true))
            break;
        ensure(std::memcmp(header.data(), "RIFF", 4) == 0 &&
                   std::memcmp(header.data() + 8, "WEBP", 4) == 0,
               "FFmpeg output is not a WebP RIFF image.");
        const auto declared = le32(header.data() + 4);
        ensure(declared >= 12 && declared <= max_webp_bytes - 8, "Invalid or oversized WebP page.");
        const auto length = static_cast<std::size_t>(declared) + 8;
        Bytes page(length);
        std::copy(header.begin(), header.end(), page.begin());
        read_exact(process, page.data() + 12, length - 12);
        ensure(std::memcmp(page.data() + 12, "VP8L", 4) == 0 &&
                   20ull + le32(page.data() + 16) + (le32(page.data() + 16) & 1u) == length,
               "FFmpeg must produce one lossless VP8L chunk per page.");
        ensure(consumed < durations.size(), "FFmpeg produced too many alpha frames.");
        const Bytes payload(page.begin() + 12, page.end());
        if (pages.empty() || payload != previous) {
            const bool nonopaque = has_nonopaque_alpha(payload, width, height);
            has_transparency = has_transparency || nonopaque;
            holds.push_back({elapsed, durations[consumed]});
            pages.push_back(payload);
            compressed_size += payload.size() + 64;
            ensure(compressed_size <= max_webp_bytes, "Compressed alpha WebP exceeds 128 MiB.");
            previous = payload;
        } else {
            holds.back().duration += durations[consumed];
        }
        elapsed += durations[consumed];
        ++consumed;
    }
    const auto diagnostics = process.finish();
    ensure(consumed == durations.size() && elapsed == expected_endpoint,
           "FFmpeg output does not match the prepared color frame count.");

    if (!has_transparency)
        return {{"ok", true},
                {"hasAlpha", false},
                {"stderr", diagnostics},
                {"holds", Json::array()},
                {"frameCount", consumed}};
    Bytes webp = build_webp(pages, holds, width, height);
#if defined(_WIN32)
    const std::filesystem::path destination(wide(output_path));
#else
    const std::filesystem::path destination(output_path);
#endif
    ensure(destination.is_absolute() && destination.filename() == "alpha.webp",
           "Native alpha output must be an absolute alpha.webp path.");
    const auto partial = destination.parent_path() / "alpha.webp.partial";
    struct Cleanup {
        std::filesystem::path path;
        ~Cleanup()
        {
            std::error_code ec;
            std::filesystem::remove(path, ec);
        }
    } cleanup{partial};
    {
        std::ofstream stream(partial, std::ios::binary | std::ios::trunc);
        ensure(stream.good(), "Cannot open native alpha output.");
        stream.write(reinterpret_cast<const char*>(webp.data()),
                     static_cast<std::streamsize>(webp.size()));
        ensure(stream.good(), "Failed writing native alpha output.");
    }
    std::filesystem::rename(partial, destination);
    Json hold_values = Json::array();
    for (const auto& hold : holds)
        hold_values.push_back({{"startMs", hold.start}, {"durationMs", hold.duration}});
    return {{"ok", true},
            {"hasAlpha", true},
            {"stderr", diagnostics},
            {"holds", std::move(hold_values)},
            {"frameCount", consumed},
            {"webpBytes", webp.size()}};
}

} // namespace

extern "C" std::uint64_t noveltea_tooling_encode_alpha_webp_json(const std::uint8_t* request,
                                                                 std::uint64_t request_size,
                                                                 std::uint8_t* response,
                                                                 std::uint64_t response_capacity)
{
    Json result;
    try {
        ensure(request && request_size > 0, "Native alpha request is missing.");
        result = encode(Json::parse(request, request + request_size));
    } catch (const std::exception& e) {
        result = {{"ok", false}, {"error", e.what()}};
    }
    const auto text = result.dump();
    if (response && response_capacity >= text.size())
        std::memcpy(response, text.data(), text.size());
    return text.size();
}
