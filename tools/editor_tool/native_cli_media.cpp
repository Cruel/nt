#include "native_cli_media.hpp"
#include "native_cli_paths.hpp"
#include "native_cli_media_pin.hpp"

#include <algorithm>
#include <array>
#include <cstdlib>
#include <filesystem>
#include <regex>
#include <stdexcept>
#include <string>
#include <string_view>
#include <vector>
#if defined(_WIN32)
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <Windows.h>
#elif defined(__APPLE__)
#include <mach-o/dyld.h>
#include <sys/wait.h>
#include <unistd.h>
#else
#include <sys/wait.h>
#include <unistd.h>
#endif

namespace noveltea::cli {
namespace {
namespace fs = std::filesystem;

std::string text_path(const fs::path& path)
{
    const auto value = path.u8string();
    return {value.begin(), value.end()};
}

fs::path executable_path()
{
#if defined(_WIN32)
    std::wstring buffer(32768, L'\0');
    const auto count =
        GetModuleFileNameW(nullptr, buffer.data(), static_cast<DWORD>(buffer.size()));
    if (!count || count == buffer.size())
        throw std::runtime_error("Cannot resolve native CLI executable path.");
    buffer.resize(count);
    return fs::canonical(fs::path(buffer));
#elif defined(__APPLE__)
    std::uint32_t size = 0;
    _NSGetExecutablePath(nullptr, &size);
    std::string buffer(size, '\0');
    if (_NSGetExecutablePath(buffer.data(), &size) != 0)
        throw std::runtime_error("Cannot resolve native CLI executable path.");
    return fs::canonical(buffer.c_str());
#else
    return fs::canonical("/proc/self/exe");
#endif
}

struct ProcessResult {
    int exit_code = -1;
    std::string output;
};

#if defined(_WIN32)
std::wstring quote_windows(const std::wstring& arg)
{
    std::wstring result = L"\"";
    std::size_t slashes = 0;
    for (const wchar_t ch : arg) {
        if (ch == L'\\') {
            ++slashes;
            continue;
        }
        if (ch == L'"') {
            result.append(slashes * 2 + 1, L'\\');
            result.push_back(ch);
        } else {
            result.append(slashes, L'\\');
            result.push_back(ch);
        }
        slashes = 0;
    }
    result.append(slashes * 2, L'\\');
    result.push_back(L'"');
    return result;
}
#endif

ProcessResult run_tool(const fs::path& executable, const std::vector<std::string>& arguments)
{
#if defined(_WIN32)
    SECURITY_ATTRIBUTES attributes{sizeof(SECURITY_ATTRIBUTES), nullptr, TRUE};
    HANDLE reader = nullptr, writer = nullptr;
    if (!CreatePipe(&reader, &writer, &attributes, 0))
        throw std::runtime_error("Cannot create FFmpeg diagnostic pipe.");
    SetHandleInformation(reader, HANDLE_FLAG_INHERIT, 0);
    STARTUPINFOW startup{};
    startup.cb = sizeof(startup);
    startup.dwFlags = STARTF_USESTDHANDLES;
    startup.hStdOutput = writer;
    startup.hStdError = writer;
    startup.hStdInput = GetStdHandle(STD_INPUT_HANDLE);
    std::wstring command = quote_windows(executable.wstring());
    for (const auto& arg : arguments)
        command += L" " + quote_windows(std::wstring(arg.begin(), arg.end()));
    PROCESS_INFORMATION process{};
    const bool launched =
        CreateProcessW(executable.c_str(), command.data(), nullptr, nullptr, TRUE, CREATE_NO_WINDOW,
                       nullptr, nullptr, &startup, &process) != 0;
    CloseHandle(writer);
    if (!launched) {
        CloseHandle(reader);
        throw std::runtime_error("Cannot execute media tool '" + text_path(executable) + "'.");
    }
    ProcessResult result;
    std::array<char, 8192> buffer;
    DWORD count = 0;
    while (ReadFile(reader, buffer.data(), static_cast<DWORD>(buffer.size()), &count, nullptr) &&
           count)
        result.output.append(buffer.data(), count);
    CloseHandle(reader);
    WaitForSingleObject(process.hProcess, INFINITE);
    DWORD status = 0;
    GetExitCodeProcess(process.hProcess, &status);
    CloseHandle(process.hThread);
    CloseHandle(process.hProcess);
    result.exit_code = static_cast<int>(status);
    return result;
#else
    int fds[2];
    if (pipe(fds) != 0)
        throw std::runtime_error("Cannot create FFmpeg diagnostic pipe.");
    const pid_t pid = fork();
    if (pid < 0) {
        close(fds[0]);
        close(fds[1]);
        throw std::runtime_error("Cannot launch FFmpeg inspection process.");
    }
    if (pid == 0) {
        close(fds[0]);
        dup2(fds[1], STDOUT_FILENO);
        dup2(fds[1], STDERR_FILENO);
        close(fds[1]);
        std::vector<std::string> stored{text_path(executable)};
        stored.insert(stored.end(), arguments.begin(), arguments.end());
        std::vector<char*> argv;
        for (auto& value : stored)
            argv.push_back(value.data());
        argv.push_back(nullptr);
        execv(argv[0], argv.data());
        _exit(127);
    }
    close(fds[1]);
    ProcessResult result;
    std::array<char, 8192> buffer;
    ssize_t count = 0;
    while ((count = read(fds[0], buffer.data(), buffer.size())) > 0)
        result.output.append(buffer.data(), static_cast<std::size_t>(count));
    close(fds[0]);
    int status = 0;
    if (waitpid(pid, &status, 0) < 0)
        throw std::runtime_error("Cannot reap FFmpeg inspection process.");
    result.exit_code = WIFEXITED(status) ? WEXITSTATUS(status) : -1;
    return result;
#endif
}

std::string run_checked(const fs::path& executable, const std::vector<std::string>& arguments)
{
    const auto result = run_tool(executable, arguments);
    if (result.exit_code != 0)
        throw std::runtime_error("Media tool '" + text_path(executable) + "' failed (" +
                                 std::to_string(result.exit_code) + "): " +
                                 (result.output.empty() ? "no diagnostics" : result.output));
    return result.output;
}

bool token_present(std::string_view text, std::string_view token)
{
    std::size_t position = 0;
    while ((position = text.find(token, position)) != std::string_view::npos) {
        const auto start = position;
        position += token.size();
        const auto whitespace = [](char ch) {
            return ch == ' ' || ch == '\t' || ch == '\r' || ch == '\n' || ch == '\f';
        };
        if ((start == 0 || whitespace(text[start - 1])) &&
            (position == text.size() || whitespace(text[position])))
            return true;
    }
    return false;
}
} // namespace

nlohmann::json inspect_native_media_tool()
{
    const char* override = std::getenv("NOVELTEA_FFMPEG");
    const bool bundled = override == nullptr;
    fs::path executable;
    if (!bundled) {
        executable = native_path_from_utf8(override);
        if (!executable.is_absolute())
            throw std::runtime_error("NOVELTEA_FFMPEG must name an absolute executable path.");
    } else {
        const auto binary = executable_path();
        const auto directory = binary.parent_path();
        const auto install = directory.filename() == "bin" ? directory.parent_path() : directory;
#if defined(_WIN32)
        executable = install / "tools/ffmpeg/bin/ffmpeg.exe";
#else
        executable = install / "tools/ffmpeg/bin/ffmpeg";
#endif
    }
    const auto identity = run_checked(executable, {"-version"});
    const std::regex pattern(R"((?:^|\n)ffmpeg version (\S+))");
    std::smatch match;
    if (!std::regex_search(identity, match, pattern) ||
        (bundled && match[1].str() != media_pin_version))
        throw std::runtime_error(
            "Media tool '" + text_path(executable) + "' has wrong identity; expected FFmpeg " +
            (bundled ? std::string(media_pin_version) : "(external build)") + ".");
    if (bundled) {
        for (const std::string_view flag :
             {"--disable-gpl", "--disable-nonfree", "--disable-version3", "--disable-network",
              "--enable-libaom", "--enable-libvpx", "--enable-libwebp", "--enable-libzimg"})
            if (!token_present(identity, flag))
                throw std::runtime_error("Bundled FFmpeg " + std::string(media_pin_release) +
                                         " is missing configuration " + std::string(flag) + ".");
    }
    const auto encoders = run_checked(executable, {"-hide_banner", "-encoders"});
    for (const std::string_view encoder :
         {"libaom-av1", "libvpx-vp9", bundled ? "libwebp_anim" : "libaom-av1"})
        if (!token_present(encoders, encoder))
            throw std::runtime_error("Media tool '" + text_path(executable) +
                                     "' is missing encoder " + std::string(encoder) + ".");
    const auto protocols = run_checked(executable, {"-hide_banner", "-protocols"});
    for (const std::string_view protocol : {"file", "pipe"})
        if (!token_present(protocols, protocol))
            throw std::runtime_error("Media tool '" + text_path(executable) +
                                     "' is missing protocol " + std::string(protocol) + ".");
    return {{"executable", text_path(executable)},
            {"bundled", bundled},
            {"version", match[1].str()},
            {"release", bundled ? nlohmann::json(media_pin_release) : nlohmann::json(nullptr)}};
}
} // namespace noveltea::cli
