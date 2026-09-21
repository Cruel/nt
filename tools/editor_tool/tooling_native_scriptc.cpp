#include "tooling_daemon_broker.hpp"
#include "tooling_native_c.h"

#include <nlohmann/json.hpp>

#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <filesystem>
#include <fstream>
#include <limits>
#include <cstring>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#if defined(_WIN32)
#include <io.h>
#include <windows.h>
#else
#include <sys/ioctl.h>
#include <unistd.h>
#endif

namespace {

using NativeOperation = std::uint64_t (*)(const std::uint8_t*, std::uint64_t, std::uint8_t*,
                                          std::uint64_t);

constexpr std::size_t native_response_headroom = 64 * 1024;

std::uint64_t terminal_size_json(const std::uint8_t*, std::uint64_t, std::uint8_t* response,
                                 std::uint64_t response_capacity)
{
    nlohmann::json result = {{"columns", nullptr}, {"rows", nullptr}};
#if defined(_WIN32)
    CONSOLE_SCREEN_BUFFER_INFO info{};
    const auto output = GetStdHandle(STD_OUTPUT_HANDLE);
    if (output != INVALID_HANDLE_VALUE && output != nullptr && GetConsoleScreenBufferInfo(output, &info)) {
        result["columns"] = static_cast<std::uint64_t>(info.srWindow.Right - info.srWindow.Left + 1);
        result["rows"] = static_cast<std::uint64_t>(info.srWindow.Bottom - info.srWindow.Top + 1);
    }
#else
    winsize size{};
    if (::ioctl(STDOUT_FILENO, TIOCGWINSZ, &size) == 0 && size.ws_col > 0 && size.ws_row > 0) {
        result["columns"] = static_cast<std::uint64_t>(size.ws_col);
        result["rows"] = static_cast<std::uint64_t>(size.ws_row);
    }
#endif
    const auto text = result.dump();
    const auto required = static_cast<std::uint64_t>(text.size());
    if (response != nullptr && response_capacity >= required && required != 0)
        std::memcpy(response, text.data(), text.size());
    return required;
}

std::size_t response_capacity(std::uint64_t required)
{
    const auto size = static_cast<std::size_t>(required);
    if (size > (std::numeric_limits<std::size_t>::max)() - native_response_headroom)
        return size;
    return size + native_response_headroom;
}

NativeOperation operation_for(std::string_view operation)
{
    if (operation == "compile-shaders")
        return &noveltea_tooling_compile_shaders_json;
    if (operation == "run-test")
        return &noveltea_tooling_run_headless_test_json;
    if (operation == "run-test-suite")
        return &noveltea_tooling_run_test_suite_json;
    if (operation == "run-ui-test")
        return &noveltea_tooling_run_ui_test_json;
    if (operation == "export-package")
        return &noveltea_tooling_export_package_json;
    if (operation == "font-coverage")
        return &noveltea_tooling_validate_font_coverage_json;
    if (operation == "shaderc")
        return &noveltea_tooling_shaderc_json;
    if (operation == "texturec")
        return &noveltea_tooling_texturec_json;
    if (operation == "image-inspect")
        return &noveltea_tooling_image_inspect_json;
    if (operation == "image-resize-png")
        return &noveltea_tooling_image_resize_png_json;
    if (operation == "file-mode")
        return &noveltea_tooling_file_mode_json;
    if (operation == "disk-space")
        return &noveltea_tooling_disk_space_json;
    if (operation == "path-metadata")
        return &noveltea_tooling_path_metadata_json;
    if (operation == "authoring-cache-probe")
        return &noveltea_tooling_probe_authoring_cache_json;
    if (operation == "runtime-cache-probe")
        return &noveltea_tooling_probe_runtime_cache_json;
    if (operation == "create-archive")
        return &noveltea_tooling_create_archive_json;
    if (operation == "daemon")
        return &noveltea_tooling_daemon_json;
    if (operation == "terminal-size")
        return &terminal_size_json;
    return nullptr;
}

std::filesystem::path filesystem_path_from_utf8(std::string_view value)
{
#if defined(_WIN32)
    if (value.empty())
        return {};
    const int required = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value.data(),
                                             static_cast<int>(value.size()), nullptr, 0);
    if (required <= 0)
        return {};
    std::wstring wide(static_cast<std::size_t>(required), L'\0');
    const int written = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value.data(),
                                            static_cast<int>(value.size()), wide.data(), required);
    if (written != required)
        return {};
    return std::filesystem::path(std::move(wide));
#else
    return std::filesystem::path(value);
#endif
}

void write_text(std::string_view path, std::string_view text)
{
    std::ofstream output(filesystem_path_from_utf8(path), std::ios::binary | std::ios::trunc);
    output.write(text.data(), static_cast<std::streamsize>(text.size()));
}

int duplicate_fd(int fd)
{
#if defined(_WIN32)
    return _dup(fd);
#else
    return ::dup(fd);
#endif
}

bool replace_fd(int source, int target)
{
#if defined(_WIN32)
    return _dup2(source, target) == 0;
#else
    return ::dup2(source, target) >= 0;
#endif
}

void close_fd(int fd)
{
#if defined(_WIN32)
    _close(fd);
#else
    ::close(fd);
#endif
}

int file_fd(std::FILE* file)
{
#if defined(_WIN32)
    return _fileno(file);
#else
    return ::fileno(file);
#endif
}

std::string read_capture(std::FILE* file)
{
    if (file == nullptr)
        return {};
    std::fflush(file);
    if (std::fseek(file, 0, SEEK_END) != 0)
        return {};
    const auto length = std::ftell(file);
    if (length <= 0 || std::fseek(file, 0, SEEK_SET) != 0)
        return {};
    std::string result(static_cast<std::size_t>(length), '\0');
    const auto read = std::fread(result.data(), 1, result.size(), file);
    result.resize(read);
    return result;
}

struct CapturedNativeResponse {
    bool ok = false;
    std::string response;
    std::string stdout_text;
    std::string stderr_text;
};

CapturedNativeResponse invoke_captured(NativeOperation operation, const std::uint8_t* request_bytes,
                                       std::size_t request_size)
{
    std::fflush(stdout);
    std::fflush(stderr);
    std::FILE* stdout_capture = std::tmpfile();
    std::FILE* stderr_capture = std::tmpfile();
    const int stdout_copy = duplicate_fd(file_fd(stdout));
    const int stderr_copy = duplicate_fd(file_fd(stderr));
    const bool resources_ready = stdout_capture != nullptr && stderr_capture != nullptr &&
                                 stdout_copy >= 0 && stderr_copy >= 0;
    bool stdout_redirected = false;
    bool stderr_redirected = false;
    if (resources_ready) {
        stdout_redirected = replace_fd(file_fd(stdout_capture), file_fd(stdout));
        if (stdout_redirected)
            stderr_redirected = replace_fd(file_fd(stderr_capture), file_fd(stderr));
    }
    if (!stdout_redirected || !stderr_redirected) {
        if (stdout_redirected)
            replace_fd(stdout_copy, file_fd(stdout));
        if (stderr_redirected)
            replace_fd(stderr_copy, file_fd(stderr));
        if (stdout_copy >= 0)
            close_fd(stdout_copy);
        if (stderr_copy >= 0)
            close_fd(stderr_copy);
        if (stdout_capture != nullptr)
            std::fclose(stdout_capture);
        if (stderr_capture != nullptr)
            std::fclose(stderr_capture);
        return {};
    }

    const auto required = operation(request_bytes, static_cast<std::uint64_t>(request_size), nullptr, 0);
    std::vector<std::uint8_t> response(response_capacity(required));
    const auto written = operation(request_bytes, static_cast<std::uint64_t>(request_size),
                                   response.data(), response.size());
    std::fflush(stdout);
    std::fflush(stderr);
    replace_fd(stdout_copy, file_fd(stdout));
    replace_fd(stderr_copy, file_fd(stderr));
    close_fd(stdout_copy);
    close_fd(stderr_copy);

    CapturedNativeResponse captured;
    captured.ok = true;
    captured.stdout_text = read_capture(stdout_capture);
    captured.stderr_text = read_capture(stderr_capture);
    std::fclose(stdout_capture);
    std::fclose(stderr_capture);
    if (written <= response.size())
        captured.response.assign(reinterpret_cast<const char*>(response.data()),
                                 static_cast<std::size_t>(written));
    return captured;
}

} // namespace

extern "C" void noveltea_tooling_scriptc_invoke_to_file(const std::uint8_t* operation_bytes,
                                                        std::size_t operation_size,
                                                        const std::uint8_t* request_bytes,
                                                        std::size_t request_size,
                                                        const std::uint8_t* response_path_bytes,
                                                        std::size_t response_path_size)
{
    const std::string_view requested_operation(reinterpret_cast<const char*>(operation_bytes),
                                               operation_size);
    constexpr std::string_view capture_prefix = "capture:";
    const bool capture_output = requested_operation.starts_with(capture_prefix);
    const std::string_view operation = capture_output
                                           ? requested_operation.substr(capture_prefix.size())
                                           : requested_operation;
    const std::string_view response_path(reinterpret_cast<const char*>(response_path_bytes),
                                         response_path_size);
    const auto native_operation = operation_for(operation);
    if (native_operation == nullptr) {
        write_text(response_path, R"({"ok":false,"error":"unknown native operation"})");
        return;
    }

    if (capture_output && operation != "daemon") {
        const auto captured = invoke_captured(native_operation, request_bytes, request_size);
        const auto envelope = nlohmann::json{{"captureOk", captured.ok},
                                             {"response", captured.response},
                                             {"stdout", captured.stdout_text},
                                             {"stderr", captured.stderr_text}}
                                  .dump();
        write_text(response_path, envelope);
        return;
    }

    if (operation == "daemon") {
        std::vector<std::uint8_t> response(noveltea::tooling::daemon::max_frame_bytes);
        const auto written =
            native_operation(request_bytes, static_cast<std::uint64_t>(request_size),
                             response.data(), response.size());
        if (written > response.size()) {
            write_text(response_path, R"({"ok":false,"error":"native response overflow"})");
            return;
        }
        if (written == 0) {
            write_text(response_path, {});
            return;
        }
        write_text(response_path, std::string_view(reinterpret_cast<const char*>(response.data()),
                                                   static_cast<std::size_t>(written)));
        return;
    }

    const auto required =
        native_operation(request_bytes, static_cast<std::uint64_t>(request_size), nullptr, 0);
    std::vector<std::uint8_t> response(response_capacity(required));
    const auto written = native_operation(request_bytes, static_cast<std::uint64_t>(request_size),
                                          response.data(), response.size());
    if (written > response.size()) {
        write_text(response_path, R"({"ok":false,"error":"native response overflow"})");
        return;
    }
    if (written == 0) {
        write_text(response_path, {});
        return;
    }
    write_text(response_path, std::string_view(reinterpret_cast<const char*>(response.data()),
                                               static_cast<std::size_t>(written)));
}
