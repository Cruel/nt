#include "tooling_native_asset_media.hpp"

#include <chrono>
#include <cstring>
#include <cstdlib>
#include <string>
#include <vector>

#if defined(_WIN32)
#include <Windows.h>
#else
#include <cerrno>
#include <csignal>
#include <fcntl.h>
#include <poll.h>
#include <spawn.h>
#include <sys/wait.h>
#include <unistd.h>
extern char** environ;
#endif

namespace {
bool has_decoded_frame(std::string_view output)
{
    for (std::size_t start = 0; start < output.size();) {
        const auto next = output.find('\n', start);
        const auto line =
            output.substr(start, (next == output.npos ? output.size() : next) - start);
        auto cursor = line.find_first_not_of(" \t\r");
        if (cursor != line.npos && line[cursor] == '0') {
            ++cursor;
            cursor = line.find_first_not_of(" \t", cursor);
            if (cursor != line.npos && line[cursor] == ',')
                return true;
        }
        if (next == output.npos)
            break;
        start = next + 1;
    }
    return false;
}

#if defined(_WIN32)
std::wstring quote(std::wstring_view text)
{
    std::wstring result = L"\"";
    unsigned slashes = 0;
    for (const wchar_t character : text) {
        if (character == L'\\') {
            ++slashes;
        } else {
            if (character == L'"')
                result.append(slashes * 2 + 1, L'\\');
            else
                result.append(slashes, L'\\');
            slashes = 0;
            result.push_back(character);
        }
    }
    result.append(slashes * 2, L'\\');
    return result + L'"';
}

bool run_probe(const std::filesystem::path& source, std::string_view kind)
{
    const wchar_t* override = _wgetenv(L"NOVELTEA_FFMPEG");
    const auto executable =
        override && *override ? std::filesystem::path(override) : std::filesystem::path(L"ffmpeg");
    const auto stream = kind == "audio" ? L"a" : L"v";
    const std::vector<std::wstring> args{executable.wstring(),
                                         L"-nostdin",
                                         L"-hide_banner",
                                         L"-loglevel",
                                         L"error",
                                         L"-xerror",
                                         L"-i",
                                         source.wstring(),
                                         L"-map",
                                         std::wstring(L"0:") + stream + L":0",
                                         std::wstring(L"-frames:") + stream,
                                         L"1",
                                         L"-f",
                                         L"framehash",
                                         L"pipe:1"};
    std::wstring command;
    for (const auto& arg : args) {
        if (!command.empty())
            command += L' ';
        command += quote(arg);
    }
    SECURITY_ATTRIBUTES security{sizeof(security), nullptr, TRUE};
    HANDLE read_end = nullptr, write_end = nullptr;
    if (!CreatePipe(&read_end, &write_end, &security, 0))
        return false;
    SetHandleInformation(read_end, HANDLE_FLAG_INHERIT, 0);
    STARTUPINFOW startup{};
    startup.cb = sizeof(startup);
    startup.dwFlags = STARTF_USESTDHANDLES;
    HANDLE input_null = CreateFileW(L"NUL", GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE,
                                    &security, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
    HANDLE error_null = CreateFileW(L"NUL", GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE,
                                    &security, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (input_null == INVALID_HANDLE_VALUE || error_null == INVALID_HANDLE_VALUE) {
        if (input_null != INVALID_HANDLE_VALUE)
            CloseHandle(input_null);
        if (error_null != INVALID_HANDLE_VALUE)
            CloseHandle(error_null);
        CloseHandle(read_end);
        CloseHandle(write_end);
        return false;
    }
    startup.hStdInput = input_null;
    startup.hStdOutput = write_end;
    startup.hStdError = error_null;
    PROCESS_INFORMATION process{};
    const bool started = CreateProcessW(nullptr, command.data(), nullptr, nullptr, TRUE,
                                        CREATE_NO_WINDOW, nullptr, nullptr, &startup, &process);
    CloseHandle(write_end);
    CloseHandle(input_null);
    CloseHandle(error_null);
    if (!started) {
        CloseHandle(read_end);
        return false;
    }
    const DWORD wait = WaitForSingleObject(process.hProcess, 20'000);
    if (wait != WAIT_OBJECT_0)
        TerminateProcess(process.hProcess, 1);
    DWORD status = 1;
    GetExitCodeProcess(process.hProcess, &status);
    std::string output;
    if (wait == WAIT_OBJECT_0 && status == 0) {
        char buffer[4096];
        DWORD count = 0;
        while (output.size() < 32 * 1024 &&
               ReadFile(read_end, buffer, sizeof(buffer), &count, nullptr) && count > 0)
            output.append(buffer, count);
    }
    CloseHandle(read_end);
    CloseHandle(process.hThread);
    CloseHandle(process.hProcess);
    return wait == WAIT_OBJECT_0 && status == 0 && has_decoded_frame(output);
}
#else
bool run_probe(const std::filesystem::path& source, std::string_view kind)
{
    const char* override = std::getenv("NOVELTEA_FFMPEG");
    const std::string program = override && *override ? override : "ffmpeg";
    const auto stream = kind == "audio" ? "a" : "v";
    const auto map = std::string("0:") + stream + ":0";
    const auto frames = std::string("-frames:") + stream;
    const auto name = source.string();
    std::vector<std::string> storage{program,   "-nostdin", "-hide_banner", "-loglevel", "error",
                                     "-xerror", "-i",       name,           "-map",      map,
                                     frames,    "1",        "-f",           "framehash", "pipe:1"};
    std::vector<char*> argv;
    for (auto& arg : storage)
        argv.push_back(arg.data());
    argv.push_back(nullptr);
    int descriptors[2]{};
    if (pipe(descriptors) != 0)
        return false;
    posix_spawn_file_actions_t actions;
    posix_spawn_file_actions_init(&actions);
    posix_spawn_file_actions_adddup2(&actions, descriptors[1], STDOUT_FILENO);
    posix_spawn_file_actions_addopen(&actions, STDERR_FILENO, "/dev/null", O_WRONLY, 0);
    posix_spawn_file_actions_addclose(&actions, descriptors[0]);
    posix_spawn_file_actions_addclose(&actions, descriptors[1]);
    pid_t pid = -1;
    const int started =
        posix_spawnp(&pid, program.c_str(), &actions, nullptr, argv.data(), environ);
    posix_spawn_file_actions_destroy(&actions);
    close(descriptors[1]);
    if (started != 0) {
        close(descriptors[0]);
        return false;
    }
    const int flags = fcntl(descriptors[0], F_GETFL, 0);
    fcntl(descriptors[0], F_SETFL, flags | O_NONBLOCK);
    const auto end = std::chrono::steady_clock::now() + std::chrono::seconds(20);
    std::string output;
    int status = 0;
    bool finished = false;
    while (std::chrono::steady_clock::now() < end && output.size() <= 32 * 1024) {
        char buffer[4096];
        const auto count = read(descriptors[0], buffer, sizeof(buffer));
        if (count > 0)
            output.append(buffer, static_cast<std::size_t>(count));
        const auto waited = waitpid(pid, &status, WNOHANG);
        if (waited == pid) {
            finished = true;
            while (output.size() <= 32 * 1024) {
                const auto trailing = read(descriptors[0], buffer, sizeof(buffer));
                if (trailing <= 0)
                    break;
                output.append(buffer, static_cast<std::size_t>(trailing));
            }
            break;
        }
        if (waited < 0)
            break;
        pollfd check{descriptors[0], POLLIN, 0};
        poll(&check, 1, 50);
    }
    if (!finished) {
        kill(pid, SIGKILL);
        waitpid(pid, &status, 0);
    }
    close(descriptors[0]);
    return finished && WIFEXITED(status) && WEXITSTATUS(status) == 0 &&
           output.size() <= 32 * 1024 && has_decoded_frame(output);
}
#endif
} // namespace

bool native_probe_asset_media(const std::filesystem::path& source, std::string_view kind)
{
    return (kind == "audio" || kind == "video") && run_probe(source, kind);
}
