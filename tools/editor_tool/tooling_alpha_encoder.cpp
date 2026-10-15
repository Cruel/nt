#include "tooling_native_c.h"
#include "media/animated_webp_alpha.hpp"

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

// Consume a single complete animated WebP from FFmpeg's libwebp_anim encoder.
// We enforce the compressed output cap while reading, before FFmpeg can publish
// any file. FFmpeg may buffer the animation internally, unlike the old page
// streamer; subprocess lifetime and diagnostics remain explicitly bounded.
Bytes read_webp(FfmpegProcess& process)
{
    Bytes result;
    std::array<std::uint8_t, 65536> buffer{};
    for (;;) {
        const auto received = process.read(buffer.data(), buffer.size());
        if (received == 0)
            break;
        ensure(result.size() <= max_webp_bytes - received,
               "Compressed animated WebP exceeds the 128 MiB package limit.");
        result.insert(result.end(), buffer.begin(), buffer.begin() + received);
    }
    ensure(result.size() >= 20 && result.size() <= max_webp_bytes &&
               std::memcmp(result.data(), "RIFF", 4) == 0 &&
               std::memcmp(result.data() + 8, "WEBP", 4) == 0 &&
               static_cast<std::uint64_t>(le32(result.data() + 4)) + 8 == result.size(),
           "FFmpeg did not produce a complete animated WebP RIFF.");
    return result;
}

// FFmpeg's patched libwebp_anim knows the input frame's nominal duration,
// but range trimming can end mid-frame. Only adjust the final ANMF duration
// to the authoritatively sampled color endpoint; never change compressed
// pixels, frame rectangles, or any preceding sample timing.
void normalize_final_hold(Bytes& webp, const std::vector<std::uint64_t>& boundaries)
{
    std::size_t at = 12;
    std::size_t last_duration_offset = 0;
    std::uint64_t cursor = 0;
    std::uint64_t last_start = 0;
    while (at < webp.size()) {
        ensure(at + 8 <= webp.size(), "Truncated FFmpeg animated-WebP chunk.");
        const auto size = le32(webp.data() + at + 4);
        const auto padded = static_cast<std::uint64_t>(size) + (size & 1u);
        ensure(padded <= webp.size() - at - 8, "Invalid FFmpeg animated-WebP chunk size.");
        if (std::memcmp(webp.data() + at, "ANMF", 4) == 0) {
            ensure(size >= 24, "Invalid FFmpeg animated-WebP frame.");
            last_start = cursor;
            last_duration_offset = at + 8 + 12;
            const auto* duration = webp.data() + last_duration_offset;
            const auto value = static_cast<std::uint32_t>(duration[0]) |
                               (static_cast<std::uint32_t>(duration[1]) << 8) |
                               (static_cast<std::uint32_t>(duration[2]) << 16);
            ensure(value > 0, "FFmpeg emitted a zero-duration animated-WebP frame.");
            cursor += value;
        }
        at += 8 + static_cast<std::size_t>(padded);
    }
    if (last_duration_offset == 0 || cursor == boundaries.back())
        return; // Still WebP, or FFmpeg already produced the exact endpoint.
    if (!std::binary_search(boundaries.begin(), boundaries.end(), last_start) ||
        last_start >= boundaries.back() || boundaries.back() - last_start > 0xffffff)
        throw std::runtime_error(
            "FFmpeg animated WebP cannot represent the final hold: " + std::to_string(last_start) +
            " -> " + std::to_string(cursor) + " expected " + std::to_string(boundaries.back()));
    const auto corrected = static_cast<std::uint32_t>(boundaries.back() - last_start);
    for (int byte = 0; byte < 3; ++byte)
        webp[last_duration_offset + byte] = static_cast<std::uint8_t>(corrected >> (byte * 8));
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
    ensure(arguments.back() == "pipe:1" &&
               std::adjacent_find(arguments.begin(), arguments.end(),
                                  [](const std::string& a, const std::string& b) {
                                      return a == "-c:v" && b == "libwebp_anim";
                                  }) != arguments.end(),
           "Native alpha encoder requires lossless FFmpeg libwebp_anim piped output.");

    std::vector<std::uint64_t> boundaries;
    boundaries.reserve(durations.size() + 1);
    boundaries.push_back(0);
    for (const auto duration : durations) {
        ensure(duration > 0, "Native alpha frame duration is invalid or unrepresentable.");
        ensure(boundaries.back() <= (std::numeric_limits<std::uint64_t>::max)() - duration,
               "Native alpha timeline overflow.");
        boundaries.push_back(boundaries.back() + duration);
    }
    const auto expected_endpoint = boundaries.back();

    FfmpegProcess process(executable, arguments);
    Bytes webp = read_webp(process);
    const auto diagnostics = process.finish();
    normalize_final_hold(webp, boundaries);

    // Reuse the actual native/Web player decoder, rather than defining a
    // parallel WebP subset in the authoring tool. This validates VP8L-only
    // cropped rectangles, disposal/blending, canvas bounds, complete timeline,
    // and the final hold before an asset can be published.
    noveltea::media::AnimatedWebpAlpha decoded;
    std::string error;
    if (!decoded.open(webp, static_cast<std::uint16_t>(width), static_cast<std::uint16_t>(height),
                      expected_endpoint, error))
        throw std::runtime_error("FFmpeg animated WebP is incompatible with NovelTea: " + error);
    ensure(decoded.frame_count() <= durations.size(),
           "Animated WebP has more frames than the color timeline.");
    const auto& frames = decoded.frames();
    Json holds = Json::array();
    bool has_transparency = false;
    for (const auto& frame : frames) {
        ensure(std::binary_search(boundaries.begin(), boundaries.end(), frame.start_ms) &&
                   std::binary_search(boundaries.begin(), boundaries.end(),
                                      frame.start_ms + frame.duration_ms),
               "FFmpeg optimized WebP frame boundaries disagree with prepared color samples.");
        bool changed = false;
        if (!decoded.sample(frame.start_ms, changed, error))
            throw std::runtime_error("Cannot verify FFmpeg alpha frame: " + error);
        if (!has_transparency) {
            const auto coverage = decoded.alpha();
            has_transparency = std::any_of(coverage.begin(), coverage.end(),
                                           [](std::uint8_t a) { return a != 255; });
        }
        holds.push_back({{"startMs", frame.start_ms}, {"durationMs", frame.duration_ms}});
    }

    if (!has_transparency)
        return {{"ok", true},
                {"hasAlpha", false},
                {"stderr", diagnostics},
                {"holds", Json::array()},
                {"frameCount", durations.size()}};

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
    return {{"ok", true},
            {"hasAlpha", true},
            {"stderr", diagnostics},
            {"holds", std::move(holds)},
            {"frameCount", durations.size()},
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
